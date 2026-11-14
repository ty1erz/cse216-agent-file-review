// Harness-agnostic core of the file-review plugin. Given a shell command and the
// folder it runs in, it decides whether the command is one we review, snapshots
// the real files it could touch, runs the prototype's preview engine on that
// snapshot and renders a plain-text preview. Nothing here changes real files.
//
// Agent integrations (integrations/<harness>/) only translate their hook format
// to reviewCommand() and back, so adding Codex or Cline later reuses all of this.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");

// Commands that trigger a review. Start small; the engine already simulates
// mkdir, rmdir, tar -c and gzip too, so widening this is a config change.
const DEFAULT_COMMANDS = ["rm", "cp", "mv"];
const ENGINE_COMMANDS = new Set(["rm", "cp", "mv", "mkdir", "rmdir", "tar", "gzip"]);

// Folders that are usually huge and rarely the target. They are only scanned
// when the command names them; otherwise they are kept as opaque entries.
const SKIP_UNLESS_NAMED = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".next", "dist", "build", "target", ".cache"]);
const MAX_ENTRIES = 20000;
const MAX_LIST = 15;

let loaded = null;
function load() {
  if (loaded) return loaded;
  const window = { SCENARIOS: [], SURVEY_CONFIG: {}, TODAY: new Date().toDateString() };
  const context = vm.createContext({ window, console, URL, setTimeout, clearTimeout, AbortController });
  for (const file of ["engine.js", "playground.js"]) {
    const source = fs.readFileSync(path.join(ROOT, "prototype", file), "utf8");
    vm.runInContext(source, context, { filename: file });
    if (file === "engine.js") context.Engine = window.Engine;
  }
  window.Engine.setToday(new Date().toDateString());
  loaded = { Engine: window.Engine, P: window.Playground.internals };
  return loaded;
}

function enabledCommands(env = process.env) {
  const raw = env.FILE_REVIEW_COMMANDS;
  if (!raw) return new Set(DEFAULT_COMMANDS);
  return new Set(raw.split(/[\s,]+/).filter((name) => ENGINE_COMMANDS.has(name)));
}

// Does any step run one of the reviewed commands in command position? Quoted
// text is masked first, so `echo "rm x"` and `git commit -m "mv"` are ignored.
function triggers(command, commands) {
  const { P } = load();
  const masked = P.maskQuoted(command).text;
  const names = [...commands].map((c) => c.replace(/[^a-z]/g, "")).join("|");
  if (!names) return false;
  const position = String.raw`(?:^|[;&|(\n]|\bdo|\bthen|\bxargs|-exec|-execdir|\bsudo|\benv|\bcommand|\btime|\bnohup)\s*`;
  if (new RegExp(position + String.raw`(?:\S*/)?(?:${names})(?=\s|$|;)`).test(masked)) return true;
  return commands.has("rm") && /(^|\s)-delete(\s|$)/.test(masked);
}

// A leading `cd DIR &&` (common in agent commands) moves the preview root.
function splitLeadingCd(command, cwd) {
  const m = command.match(/^\s*cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*&&\s*([\s\S]+)$/);
  if (!m) return { command, cwd };
  let dir = m[1].replace(/^["']|["']$/g, "");
  if (dir === "~" || dir.startsWith("~/")) dir = path.join(os.homedir(), dir.slice(1));
  return { command: m[2], cwd: path.resolve(cwd, dir) };
}

// The engine only knows paths relative to its root. Rewrite absolute paths
// that point inside the root, and ~ when the root is the home folder.
function relativize(command, root) {
  const home = os.homedir();
  let out = command;
  const prefixes = [root];
  try { const real = fs.realpathSync(root); if (real !== root) prefixes.push(real); } catch {}
  for (const prefix of prefixes) {
    const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(^|[\\s'"=])${esc}(?=/|[\\s'"]|$)/?`, "g"), (_, lead) => lead + "./");
  }
  if (root === home) out = out.replace(/(^|\s)~(?=\/|\s|$)/g, "$1.");
  return out;
}

// Snapshot the real folder as the engine's file list.
function snapshot(root, command) {
  const files = [];
  const opaque = [];
  const symlinks = [];
  let count = 0;
  let truncated = false;

  function walk(abs, rel) {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    if (!entries.length && rel) files.push({ path: rel + "/" });
    for (const entry of entries) {
      if (++count > MAX_ENTRIES) { truncated = true; return; }
      const childRel = rel ? rel + "/" + entry.name : entry.name;
      const childAbs = path.join(abs, entry.name);
      if (entry.isSymbolicLink()) {
        symlinks.push(childRel);
        files.push({ path: childRel, size: 0, mtime: "", note: "symlink" });
      } else if (entry.isDirectory()) {
        if (SKIP_UNLESS_NAMED.has(entry.name) && !command.includes(entry.name)) {
          opaque.push(childRel);
          files.push({ path: childRel + "/" });
        } else walk(childAbs, childRel);
      } else {
        let st = null;
        try { st = fs.statSync(childAbs); } catch {}
        files.push({ path: childRel, size: st ? st.size : 0, mtime: st ? st.mtime.toISOString().slice(0, 10) : "" });
      }
      if (truncated) return;
    }
  }
  walk(root, "");
  return { files, opaque, symlinks, truncated };
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

// Keep the header to one line in a narrow terminal: ~ for the home folder, and
// only the last two folders of a long path.
function shortPath(abs, home = os.homedir()) {
  let p = abs;
  if (home && (p === home || p.startsWith(home + path.sep))) p = "~" + p.slice(home.length);
  if (p.length <= 40) return p;
  const parts = p.split(path.sep).filter(Boolean);
  return parts.length > 2 ? "…/" + parts.slice(-2).join("/") : p;
}

function plural(n, word) { return `${n} ${word}${n === 1 ? "" : "s"}`; }

function friendly(text) {
  return String(text).replace(/the mock home/g, "the working folder").replace(/mock home/g, "working folder");
}

function listLines(items, fmt) {
  const lines = items.slice(0, MAX_LIST).map(fmt);
  if (items.length > MAX_LIST) lines.push(`    … and ${items.length - MAX_LIST} more`);
  return lines;
}

// Group the engine's effects into a short text preview.
function render(effects, { opaque = [] } = {}) {
  const by = (types) => effects.filter((e) => types.includes(e.type));
  const deleted = by(["delete"]);
  const deletedDirs = by(["delete-dir"]);
  const overwritten = effects.filter((e) => e.type === "overwrite" || (e.type === "move" && e.before));
  const moved = by(["move"]);
  const movedDirs = by(["move-dir"]);
  const created = by(["create"]);
  const newDirs = by(["mkdir", "create-dir"]);
  const lines = [];

  if (deleted.length || deletedDirs.length) {
    const bytes = deleted.reduce((s, e) => s + (e.before ? e.before.size : 0), 0);
    const parts = [deleted.length && `${plural(deleted.length, "file")} (${humanSize(bytes)})`, deletedDirs.length && plural(deletedDirs.length, "folder")].filter(Boolean);
    lines.push(`DELETE ${parts.join(" and ")} — cannot be undone`);
    lines.push(...listLines(deleted, (e) => `  - ${e.path}  ${humanSize(e.before ? e.before.size : 0)}`));
    if (!deleted.length) lines.push(...listLines(deletedDirs, (e) => `  - ${e.path}/`));
  }
  if (overwritten.length) {
    lines.push(`OVERWRITE ${plural(overwritten.length, "file")} — old contents are lost`);
    lines.push(...listLines(overwritten, (e) => `  ! ${e.path}  (${humanSize(e.before.size)}, replaced by ${e.from})`));
  }
  const plainMoves = moved.filter((e) => !e.before);
  if (plainMoves.length || movedDirs.length) {
    lines.push(`MOVE ${[plainMoves.length && plural(plainMoves.length, "file"), movedDirs.length && plural(movedDirs.length, "folder")].filter(Boolean).join(" and ")}`);
    lines.push(...listLines(movedDirs, (e) => `  > ${e.from}/ -> ${e.path}/`));
    lines.push(...listLines(plainMoves, (e) => `  > ${e.from} -> ${e.path}`));
  }
  if (created.length) {
    lines.push(`CREATE ${plural(created.length, "file")}`);
    lines.push(...listLines(created, (e) => `  + ${e.path}${e.from ? `  (from ${e.from})` : ""}`));
  }
  if (newDirs.length) {
    lines.push(`NEW FOLDER ${plural(newDirs.length, "folder")}`);
    lines.push(...listLines(newDirs, (e) => `  + ${e.path}/`));
  }
  const hidden = opaque.filter((dir) => effects.some((e) => [e.path, e.from].some((p) => p && (p === dir || p.startsWith(dir + "/")))));
  if (hidden.length) lines.push(`Note: contents of ${hidden.join(", ")} were not scanned; the real change may include more files.`);
  return lines;
}

// Main entry point. Returns
//   { status: "skip" }                          not a reviewed command
//   { status: "preview", text, effects, ... }   previewed exactly
//   { status: "unpreviewable", text, reason }   reviewed command we cannot simulate
function reviewCommand(command, cwd, options = {}) {
  const commands = options.commands || enabledCommands(options.env);
  if (typeof command !== "string" || !command.trim() || !triggers(command, commands)) return { status: "skip" };

  const { P } = load();
  const moved = splitLeadingCd(command, cwd || process.cwd());
  const root = moved.cwd;
  const header = `File change preview (in ${shortPath(root)})`;
  const fail = (reason) => ({
    status: "unpreviewable",
    reason,
    text: [header, `Could not preview: ${friendly(reason)}`, "Check the command yourself before approving."].join("\n"),
  });

  if (!fs.existsSync(root)) return fail(`folder ${root} does not exist`);
  const local = relativize(moved.command, root);
  const snap = snapshot(root, local);
  if (snap.truncated) return fail(`the folder has more than ${MAX_ENTRIES} entries`);

  let sim;
  try { sim = P.simulateSequence(local, snap.files); } catch (err) { return fail(err.message); }

  const effects = [];
  const errors = [];
  const reasons = [];
  for (const step of sim.steps) {
    // A blocked result means the engine refused to simulate (outside the
    // folder, unsupported flag...): that is "can't preview", not a run error.
    if (step.r && step.r.blocked) reasons.push(`\`${step.cmd}\`: ${step.r.errors.join("; ")}`);
    else if (step.r) { effects.push(...step.r.effects); errors.push(...step.r.errors.map(friendly)); }
    if (step.cls && step.cls.kind === "changes" && !step.skipped) reasons.push(`\`${step.cmd}\` ${step.cls.reason}`);
    if (step.skipped && step.skipReason && !reasons.length) reasons.push(`\`${step.cmd}\` skipped: ${step.skipReason}`);
  }
  if (sim.parseError) reasons.push(sim.parseError);
  if (reasons.length && !effects.length) return fail(reasons.join("; "));

  const touchesLink = snap.symlinks.filter((link) => effects.some((e) => e.path === link || e.from === link));
  const lines = [header, ...render(effects, snap)];
  if (!effects.length) lines.push("No files would change.");
  if (touchesLink.length) lines.push(`Note: ${touchesLink.join(", ")} ${touchesLink.length === 1 ? "is a symlink" : "are symlinks"}; the preview treats links as files.`);
  if (errors.length) lines.push("Errors the command would hit:", ...errors.slice(0, MAX_LIST).map((e) => `  x ${e}`));
  if (reasons.length) lines.push(`Partly previewed: ${reasons.map(friendly).join("; ")}`);
  return {
    status: reasons.length ? "unpreviewable" : "preview",
    reason: reasons.join("; "),
    text: lines.join("\n"),
    effects,
    errors,
    summary: load().Engine.summarize({ effects }),
  };
}

module.exports = { reviewCommand, enabledCommands, triggers, relativize, splitLeadingCd, snapshot, render, shortPath, DEFAULT_COMMANDS };
