// Dry run: execute the command on a copy-on-write clone of the working folder
// inside a macOS sandbox that blocks the network and every write outside the
// clone, then diff the clone before and after.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const MAX_ENTRIES = 20000;
const TIMEOUT_MS = 4000;

function available() {
  return process.platform === "darwin" && fs.existsSync(SANDBOX_EXEC);
}

// A write outside the clone kills the command, so it is detected whatever
// error message the command would have printed.
function profile(dir) {
  return `(version 1)(allow default)(deny network*)
(deny file-write* (require-not (require-any (subpath "${dir}") (literal "/dev/null") (literal "/dev/dtracehelper") (regex #"^/dev/fd/") (regex #"^/dev/tty")))
  (with send-signal SIGKILL))`;
}

function countEntries(dir, limit) {
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    let entries;
    try { entries = fs.readdirSync(stack.pop(), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++n > limit) return n;
      if (e.isDirectory()) stack.push(path.join(e.path || e.parentPath, e.name));
    }
  }
  return n;
}

function walk(root) {
  const out = new Map();
  const visit = (abs, rel) => {
    for (const name of fs.readdirSync(abs)) {
      const childAbs = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(childAbs, { bigint: true });
      const dir = st.isDirectory();
      out.set(childRel, { ino: String(st.ino), size: Number(st.size), mtime: String(st.mtimeNs), dir });
      if (dir) visit(childAbs, childRel);
    }
  };
  visit(root, "");
  return out;
}

// Point absolute paths into the real folder at the clone instead.
function retarget(command, root, clone) {
  const prefixes = new Set([root]);
  try { prefixes.add(fs.realpathSync(root)); } catch {}
  for (const p of [...prefixes]) if (p.startsWith("/private/")) prefixes.add(p.slice("/private".length));
  let out = command;
  for (const prefix of [...prefixes].sort((a, b) => b.length - a.length)) {
    const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(^|[\\s'"=:])${esc}(?=/|[\\s'";&|)]|$)`, "g"), (_, lead) => lead + clone);
  }
  return out;
}

// Temp folders outside the working folder (where agents keep scratch files)
// are redirected into the sandbox, so the real ones are never written.
const TEMP_ROOTS = ["/private/tmp/", "/tmp/", "/private/var/folders/", "/var/folders/"];
function shadowTemp(command, base) {
  let used = false;
  const out = command.replace(/(^|[\s'"=:])(\/[^\s'";&|)<>]+)/g, (m, lead, p) => {
    if (p.startsWith(base) || !TEMP_ROOTS.some((t) => p.startsWith(t))) return m;
    const shadow = path.join(base, "shadow", p);
    let real = p;
    while (real !== "/" && !fs.existsSync(real)) real = path.dirname(real);
    if (real !== "/") {
      const dir = fs.statSync(real).isDirectory() ? real : path.dirname(real);
      fs.mkdirSync(path.join(base, "shadow", dir), { recursive: true });
    }
    used = true;
    return lead + shadow;
  });
  return { command: out, used };
}

function diff(before, after) {
  const effects = [];
  const inoOf = (map) => { const m = new Map(); for (const [p, e] of map) if (!m.has(e.ino)) m.set(e.ino, p); return m; };
  const beforeByIno = inoOf(before);
  const afterByIno = inoOf(after);
  const movedDirs = [];
  const insideMovedDir = (p, q) => movedDirs.some(([f, t]) => p.startsWith(f + "/") && q === t + p.slice(f.length));
  const byDepth = [...before].sort(([a], [b]) => a.split("/").length - b.split("/").length);

  for (const [p, b] of byDepth) {
    if (!b.dir || after.has(p)) continue;
    const q = afterByIno.get(b.ino);
    if (q && after.get(q).dir && !before.has(q)) {
      if (insideMovedDir(p, q)) continue;
      effects.push({ type: "move-dir", kind: "directory", from: p, path: q });
      movedDirs.push([p, q]);
    } else {
      effects.push({ type: "delete-dir", kind: "directory", path: p });
    }
  }
  for (const [q, a] of after) {
    if (!a.dir || before.has(q)) continue;
    const p = beforeByIno.get(a.ino);
    if (!(p && before.get(p).dir && !after.has(p))) effects.push({ type: "mkdir", kind: "directory", path: q });
  }

  for (const [p, b] of before) {
    if (b.dir) continue;
    const a = after.get(p);
    if (a && a.ino === b.ino) {
      if (a.size !== b.size || a.mtime !== b.mtime) effects.push({ type: "overwrite", kind: "file", path: p, before: { size: b.size }, after: { size: a.size } });
      continue;
    }
    const q = afterByIno.get(b.ino);
    if (q && q !== p && !after.get(q).dir) {
      if (insideMovedDir(p, q)) continue;
      const old = before.get(q);
      effects.push({ type: "move", kind: "file", from: p, path: q, before: old && !old.dir ? { size: old.size } : undefined, after: { size: b.size } });
      continue;
    }
    if (a) {
      const src = beforeByIno.get(a.ino);
      if (src && src !== p) continue; // replaced by a moved file: reported as that move
      effects.push({ type: "overwrite", kind: "file", path: p, before: { size: b.size }, after: { size: a.size } });
      continue;
    }
    effects.push({ type: "delete", kind: "file", path: p, before: { size: b.size } });
  }
  for (const [q, a] of after) {
    if (a.dir || before.has(q)) continue;
    const p = beforeByIno.get(a.ino);
    if (p && !before.get(p).dir) continue;
    effects.push({ type: "create", kind: "file", path: q, after: { size: a.size } });
  }

  // gzip and gunzip write a new file and remove the old one: show them as one step.
  const deleted = new Map(effects.filter((e) => e.type === "delete").map((e) => [e.path, e]));
  for (const c of effects.filter((e) => e.type === "create")) {
    const from = c.path.endsWith(".gz") ? c.path.slice(0, -3) : c.path + ".gz";
    const d = deleted.get(from);
    if (!d) continue;
    Object.assign(c, { type: "move", from, before: undefined });
    effects.splice(effects.indexOf(d), 1);
    deleted.delete(from);
  }
  return effects;
}

function dryRun(command, root, workdir = root) {
  if (!available()) return { ok: false, reason: "no macOS sandbox on this system" };
  if (countEntries(root, MAX_ENTRIES) > MAX_ENTRIES) return { ok: false, reason: `the folder has more than ${MAX_ENTRIES} entries` };

  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "file-review-")));
  const clone = path.join(base, "root");
  const tmp = path.join(base, "tmp");
  try {
    fs.mkdirSync(clone);
    fs.mkdirSync(tmp);
    // "root/." copies the folder's contents; path.join would drop the "/.".
    const cp = spawnSync("/bin/cp", ["-cR", root.replace(/\/+$/, "") + "/.", clone], { encoding: "utf8" });
    if (cp.status !== 0) return { ok: false, reason: "could not clone the folder" };

    const before = walk(clone);
    const shadowed = shadowTemp(retarget(command, root, clone), base);
    const cwd = path.join(clone, path.relative(root, workdir));
    const run = spawnSync(SANDBOX_EXEC, ["-p", profile(base), "/bin/bash", "-c", shadowed.command], {
      cwd,
      env: { ...process.env, TMPDIR: tmp + "/", PWD: cwd },
      input: "",
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    const stderr = run.stderr || "";
    if (run.error && run.error.code === "ETIMEDOUT") return { ok: false, reason: `the dry run took longer than ${TIMEOUT_MS / 1000} s` };
    if (run.error) return { ok: false, reason: run.error.message };
    if (/sandbox_apply|sandbox-exec:/.test(stderr)) return { ok: false, reason: "the sandbox could not start here" };
    if (run.signal === "SIGKILL" || run.status === 137) return { ok: false, reason: "the command writes outside the working folder" };
    if (/Could not resolve host|nodename nor servname|Network is unreachable/.test(stderr)) return { ok: false, reason: "the command needs the network" };

    return { ok: true, effects: diff(before, walk(clone)), exitCode: run.status, stderr: stderr.trim(), usedTemp: shadowed.used };
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

module.exports = { available, dryRun, diff, retarget, shadowTemp };
