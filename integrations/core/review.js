// Core of the file-review plugin, independent of any agent. reviewCommand()
// decides whether a command is reviewed and previews it: first as a dry run in
// a sandboxed copy of the folder (sandbox.js), otherwise by simulating it on a
// list of file names, sizes and dates with the prototype's engine. Real files
// are never changed.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const sandbox = require("./sandbox.js");

const ROOT = path.resolve(__dirname, "..", "..");

// Commands that trigger a review. The simulator models all but zip, unzip and
// rsync, which only the dry run can preview. FILE_REVIEW_COMMANDS narrows it.
const DEFAULT_COMMANDS = ["rm", "cp", "mv", "mkdir", "rmdir", "tar", "gzip", "gunzip", "zip", "unzip", "rsync"];
const ENGINE_COMMANDS = new Set(DEFAULT_COMMANDS);

// Simulator only: large folders are scanned only when the command names them.
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

// A leading `cd DIR &&` or `cd DIR;` moves the simulation root.
function splitLeadingCd(command, cwd) {
  const m = command.match(/^\s*cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*([\s\S]+)$/);
  if (!m) return { command, cwd };
  let dir = m[1].replace(/^["']|["']$/g, "");
  if (dir === "~" || dir.startsWith("~/")) dir = path.join(os.homedir(), dir.slice(1));
  return { command: m[2], cwd: path.resolve(cwd, dir) };
}

// The engine reads ~ as its root and refuses absolute paths: expand ~ to the
// real home folder, then make absolute paths inside the root relative.
function relativize(command, root, home = os.homedir()) {
  let out = command;
  if (/(^|\s)~(?=\/|\s|$)/.test(out)) {
    if (!/^[\w/.@+-]+$/.test(home)) return { command: out, error: "uses ~ and the home folder path has characters the preview cannot quote" };
    out = out.replace(/(^|\s)~(?=\/|\s|$)/g, (_, lead) => lead + home);
  }
  const prefixes = new Set([root]);
  try { prefixes.add(fs.realpathSync(root)); } catch {}
  for (const p of [...prefixes]) if (p.startsWith("/private/")) prefixes.add(p.slice("/private".length));
  for (const prefix of [...prefixes].sort((a, b) => b.length - a.length)) {
    const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(^|[\\s'"=])${esc}(/+|(?=[\\s'"]|$))`, "g"), (_, lead, slash) => lead + (slash ? "" : "."));
  }
  return { command: out, error: null };
}

// Rewrite shell forms the engine does not parse into equivalent ones it does:
// line continuations, $(date), plain variables, a trailing `&& cd ..`,
// one-command `if`, and brace lists. maskQuoted() keeps character positions.
function normalizeHabits(command, maskQuoted) {
  let out = inlineVariables(inlineDates(command.replace(/\\\r?\n[ \t]*/g, " "), maskQuoted), maskQuoted);
  for (;;) {
    const m = maskQuoted(out).text.match(/\s*(?:&&|;)\s*cd(?:\s+[^\s;&|]+)?\s*;?\s*$/);
    if (!m) break;
    out = out.slice(0, m.index);
  }
  for (;;) {
    const m = /(?:^|;|&&)\s*(if\s+([^;&|]+?)\s*;\s*then\s+([^;|]+?)\s*;?\s*fi)(?=\s*(?:;|$))/d.exec(maskQuoted(out).text);
    if (!m || /(^|\s)(if|then|else|elif|fi)(\s|$)/.test(m[3])) break;
    const [start, end] = m.indices[1];
    const cond = out.slice(...m.indices[2]);
    const body = out.slice(...m.indices[3]);
    out = out.slice(0, start) + `${cond} && ${body}` + out.slice(end);
  }
  return expandBraces(out, maskQuoted);
}

// `$(date +FORMAT)` becomes the current date.
const DATE_CODES = { Y: (d) => d.getFullYear(), y: (d) => String(d.getFullYear()).slice(-2), m: (d) => d.getMonth() + 1, d: (d) => d.getDate(),
  H: (d) => d.getHours(), M: (d) => d.getMinutes(), S: (d) => d.getSeconds(), s: (d) => Math.floor(d / 1000), "%": () => "%" };
function formatDate(fmt, now) {
  const pad = (v, code) => (code === "Y" || code === "s" || code === "%" ? String(v) : String(v).padStart(2, "0"));
  const expanded = fmt.replace(/%F/g, "%Y-%m-%d").replace(/%T/g, "%H:%M:%S");
  if (/%[^YymdHMSs%]/.test(expanded)) return null;
  return expanded.replace(/%([YymdHMSs%])/g, (_, code) => pad(DATE_CODES[code](now), code));
}
function inlineDates(command, maskQuoted, now = new Date()) {
  let out = command;
  for (let guard = 0; guard < 10; guard++) {
    const masked = maskQuoted(out).text;
    const re = /\$\(\s*date\s+(['"]?)\+([^'"()\s]+)\1\s*\)/g;
    let m, done = true;
    while ((m = re.exec(out))) {
      if (masked[m.index] !== "$") continue;
      const value = formatDate(m[2], now);
      if (value == null || /[^\w.:-]/.test(value)) continue;
      out = out.slice(0, m.index) + value + out.slice(m.index + m[0].length);
      done = false;
      break;
    }
    if (done) break;
  }
  return out;
}

// `B=/x; mv $B/a` becomes `mv /x/a`, for plain values only.
function inlineVariables(command, maskQuoted) {
  let out = command;
  for (let guard = 0; guard < 10; guard++) {
    // Masking blanks quoted text, so the value is read from the original.
    const m = /(?:^|;|&&)\s*([A-Za-z_][A-Za-z0-9_]*)=/d.exec(maskQuoted(out).text);
    if (!m) break;
    const name = m[1];
    const valueStart = m.indices[0][1];
    let value, valueEnd;
    const q = out[valueStart];
    if (q === '"' || q === "'") {
      const close = out.indexOf(q, valueStart + 1);
      if (close === -1) break;
      value = out.slice(valueStart + 1, close);
      valueEnd = close + 1;
    } else {
      value = /^[^\s;&|'"`$()<>\\]*/.exec(out.slice(valueStart))[0];
      valueEnd = valueStart + value.length;
    }
    if (!value || /[\s'"`$\\]/.test(value)) break;
    const sep = /^\s*(?:;|&&)\s*/.exec(out.slice(valueEnd));
    if (!sep) break;
    let rest = out.slice(valueEnd + sep[0].length);
    // A $ that survives masking is live (unquoted or in double quotes).
    const masked = maskQuoted(rest).text;
    const ref = new RegExp(`^\\$(?:\\{${name}\\}|${name}(?![A-Za-z0-9_]))`);
    let replaced = "", last = 0;
    for (let i = masked.indexOf("$"); i !== -1; i = masked.indexOf("$", i + 1)) {
      const x = ref.exec(rest.slice(i));
      if (!x || i < last) continue;
      replaced += rest.slice(last, i) + value;
      last = i + x[0].length;
    }
    rest = replaced + rest.slice(last);
    out = out.slice(0, m.indices[1][0]) + rest;
  }
  return out;
}

// x{1,2}y -> x1y x2y; ranges and nested braces are left for the engine to refuse.
function expandBraces(command, maskQuoted) {
  let out = command;
  for (let guard = 0; guard < 20; guard++) {
    const masked = maskQuoted(out).text;
    const m = /\{([^{}\s$]*,[^{}\s$]*)\}/.exec(masked);
    if (!m) break;
    let ws = m.index, we = m.index + m[0].length;
    while (ws > 0 && !/[\s;&|]/.test(masked[ws - 1])) ws--;
    while (we < masked.length && !/[\s;&|]/.test(masked[we])) we++;
    const prefix = out.slice(ws, m.index);
    const suffix = out.slice(m.index + m[0].length, we);
    const items = out.slice(m.index + 1, m.index + m[0].length - 1).split(",");
    out = out.slice(0, ws) + items.map((item) => prefix + item + suffix).join(" ") + out.slice(we);
  }
  return out;
}

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

// ~ for the home folder, and only the last two folders of a long path.
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
    lines.push(...listLines(overwritten, (e) => `  ! ${e.path}  (${humanSize(e.before.size)}${e.from ? `, replaced by ${e.from}` : ""})`));
  }
  // A move between x and x.gz is gzip or gunzip.
  const compressed = moved.filter((e) => !e.before && e.path === e.from + ".gz");
  const decompressed = moved.filter((e) => !e.before && e.from === e.path + ".gz");
  const plainMoves = moved.filter((e) => !e.before && !compressed.includes(e) && !decompressed.includes(e));
  if (plainMoves.length || movedDirs.length) {
    lines.push(`MOVE ${[plainMoves.length && plural(plainMoves.length, "file"), movedDirs.length && plural(movedDirs.length, "folder")].filter(Boolean).join(" and ")}`);
    lines.push(...listLines(movedDirs, (e) => `  > ${e.from}/ -> ${e.path}/`));
    lines.push(...listLines(plainMoves, (e) => `  > ${e.from} -> ${e.path}`));
  }
  if (compressed.length) {
    lines.push(`COMPRESS ${plural(compressed.length, "file")} — each original is replaced by its .gz`);
    lines.push(...listLines(compressed, (e) => `  > ${e.from} -> ${e.path}`));
  }
  if (decompressed.length) {
    lines.push(`DECOMPRESS ${plural(decompressed.length, "file")} — each .gz is replaced by its contents`);
    lines.push(...listLines(decompressed, (e) => `  > ${e.from} -> ${e.path}`));
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

// Whether any part of a step changes files (`tar -t … | awk …` does not).
function changesFiles(cmd) {
  const { P } = load();
  const masked = P.maskQuoted(cmd).text;
  const parts = [];
  let start = 0;
  const re = /\|\||&&|[|;]/g;
  let m;
  while ((m = re.exec(masked))) { parts.push(cmd.slice(start, m.index)); start = m.index + m[0].length; }
  parts.push(cmd.slice(start));
  return parts.some((part) => triggers(part, ENGINE_COMMANDS) && P.classify(part.trim()).kind !== "readonly");
}

// Returns { status: "skip" } for commands that are not reviewed,
// { status: "preview", text, effects, errors } when the whole command was
// previewed, and { status: "unpreviewable", text, reason } otherwise.
// FILE_REVIEW_MODE=simulate skips the dry run.
function reviewCommand(command, cwd, options = {}) {
  const commands = options.commands || enabledCommands(options.env);
  if (typeof command !== "string" || !command.trim() || !triggers(command, commands)) return { status: "skip" };
  cwd = cwd || process.cwd();
  const mode = (options.env && options.env.FILE_REVIEW_MODE) || process.env.FILE_REVIEW_MODE || "auto";
  let note = null;
  if (mode !== "simulate") {
    const run = sandbox.dryRun(command, cwd);
    if (run.ok) return fromDryRun(run, cwd);
    note = `Dry run not possible (${run.reason}); simulated instead.`;
  }
  return simulate(command, cwd, note);
}

function fromDryRun(run, cwd) {
  const errors = run.exitCode === 0 ? [] : [`exits with status ${run.exitCode}${run.stderr ? `: ${run.stderr.split("\n")[0].slice(0, 160)}` : ""}`];
  const lines = [`File change preview (dry run in a sandboxed copy of ${shortPath(cwd)})`, ...render(run.effects)];
  if (!run.effects.length) lines.push("No files would change.");
  if (errors.length) lines.push("Errors the command would hit:", ...errors.map((e) => `  x ${e}`));
  return { status: "preview", mode: "dry-run", text: lines.join("\n"), effects: run.effects, errors };
}

function simulate(command, cwd, note) {
  const { P } = load();
  const moved = splitLeadingCd(command, cwd);
  const root = moved.cwd;
  const header = [`File change preview (in ${shortPath(root)})`, ...(note ? [note] : [])].join("\n");
  const fail = (reason, rest = []) => ({
    status: "unpreviewable",
    reason,
    text: [header, `Could not preview: ${friendly(reason)}`, ...rest, "Check the command yourself before approving."].join("\n"),
  });

  if (!fs.existsSync(root)) return fail(`folder ${root} does not exist`);
  const rel = relativize(normalizeHabits(moved.command, P.maskQuoted), root);
  if (rel.error) return fail(rel.error);
  const local = rel.command;
  const snap = snapshot(root, local);
  if (snap.truncated) return fail(`the folder has more than ${MAX_ENTRIES} entries`);

  let sim;
  try { sim = P.simulateSequence(local, snap.files); } catch (err) { return fail(err.message); }

  const effects = [];
  const errors = [];
  const reasons = [];
  // Steps not simulated and not read-only, so a later rm is never hidden.
  const unsimulated = [];
  for (const step of sim.steps) {
    if (step.r && step.r.blocked) reasons.push(`\`${step.cmd}\`: ${step.r.errors.join("; ")}`);
    else if (step.r) { effects.push(...step.r.effects); errors.push(...step.r.errors.map(friendly)); }
    if (step.cls && step.cls.kind === "changes" && !step.skipped) reasons.push(`\`${step.cmd}\` ${step.cls.reason}`);
    // Skipping the other branch of && / || is normal, not a gap.
    const normalSkip = step.harmless || /^the previous command (failed|succeeded)$/.test(step.skipReason || "");
    if (step.skipped && step.skipReason && !normalSkip && !reasons.length) reasons.push(`\`${step.cmd}\` skipped: ${step.skipReason}`);
    const missed = (step.r && step.r.blocked) || (!step.skipped && step.cls && step.cls.kind === "changes") || (step.skipped && !normalSkip);
    if (missed && !(step.cls && step.cls.kind === "readonly")) unsimulated.push(step.cmd);
  }
  if (sim.parseError) reasons.push(sim.parseError);
  const notPreviewed = unsimulated.length ? [
    `NOT PREVIEWED ${plural(unsimulated.length, "step")} that may still run (! = changes files):`,
    ...listLines(unsimulated, (cmd) => `  ${changesFiles(cmd) ? "!" : "?"} ${cmd.length > 110 ? cmd.slice(0, 107) + "..." : cmd}`),
  ] : [];
  if (reasons.length && !effects.length) return fail(reasons.join("; "), unsimulated.length > 1 ? notPreviewed : []);

  const touchesLink = snap.symlinks.filter((link) => effects.some((e) => e.path === link || e.from === link));
  const lines = [header, ...render(effects, snap)];
  if (!effects.length) lines.push("No files would change.");
  if (touchesLink.length) lines.push(`Note: ${touchesLink.join(", ")} ${touchesLink.length === 1 ? "is a symlink" : "are symlinks"}; the preview treats links as files.`);
  if (errors.length) lines.push("Errors the command would hit:", ...errors.slice(0, MAX_LIST).map((e) => `  x ${e}`));
  if (reasons.length) lines.push(...notPreviewed, `Partly previewed: ${reasons.map(friendly).join("; ")}`);
  return {
    status: reasons.length ? "unpreviewable" : "preview",
    mode: "simulate",
    reason: reasons.join("; "),
    text: lines.join("\n"),
    effects,
    errors,
    summary: load().Engine.summarize({ effects }),
  };
}

module.exports = { reviewCommand, enabledCommands, triggers, relativize, normalizeHabits, splitLeadingCd, snapshot, render, shortPath, DEFAULT_COMMANDS };
