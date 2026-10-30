// Preview engine: runs rm / cp / mv against a fake file tree and reports what
// would change. Nothing here touches real files.
//
// A tree is an array of files: { path: "docs/a.md", size: 1200, mtime: "2026-10-01" }.
// Folders are implied by paths; an empty folder is written with a trailing "/".

(function () {
  "use strict";

  function normalize(path) {
    return path.replace(/^~\//, "").replace(/^\.\//, "").replace(/\/+$/, "");
  }

  function parentOf(path) {
    const i = path.lastIndexOf("/");
    return i === -1 ? "" : path.slice(0, i);
  }

  function baseName(path) {
    return path.slice(path.lastIndexOf("/") + 1);
  }

  function join(dir, name) {
    return dir ? dir + "/" + name : name;
  }

  class FileTree {
    constructor(files) {
      this.files = new Map(); // path -> meta
      this.dirs = new Set([""]);
      for (const f of files) {
        if (f.path.endsWith("/")) this.addDir(normalize(f.path));
        else this.addFile(f.path, f);
      }
    }

    addDir(path) {
      while (path && !this.dirs.has(path)) {
        this.dirs.add(path);
        path = parentOf(path);
      }
    }

    addFile(path, meta) {
      this.files.set(path, { size: meta.size || 0, mtime: meta.mtime || "", note: meta.note });
      this.addDir(parentOf(path));
    }

    isDir(path) { return this.dirs.has(path); }
    isFile(path) { return this.files.has(path); }
    exists(path) { return this.isDir(path) || this.isFile(path); }

    children(dir) {
      const out = new Set();
      const prefix = dir ? dir + "/" : "";
      for (const p of [...this.files.keys(), ...this.dirs]) {
        if (p && p.startsWith(prefix) && p !== dir) {
          out.add(p.slice(prefix.length).split("/")[0]);
        }
      }
      return [...out].sort();
    }

    // Every file under a folder, at any depth.
    filesUnder(dir) {
      const prefix = dir + "/";
      return [...this.files.keys()].filter((p) => p.startsWith(prefix)).sort();
    }

    dirsUnder(dir) {
      const prefix = dir + "/";
      return [...this.dirs].filter((p) => p.startsWith(prefix)).sort();
    }
  }

  // Shell-style wildcard for one path segment: *, ? and [abc] / [0-9] never cross a "/".
  function segmentRegex(seg) {
    let body = "";
    for (let i = 0; i < seg.length; i++) {
      const c = seg[i];
      const close = c === "[" ? seg.indexOf("]", i + 2) : -1;
      if (c === "*") body += "[^/]*";
      else if (c === "?") body += "[^/]";
      else if (close !== -1) {
        const set = seg.slice(i + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\");
        body += "[" + set + "]";
        i = close;
      } else body += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp("^" + body + "$");
  }

  const WILDCARD = /[*?[]/;

  // Expand a pattern the way the shell would. A pattern that matches nothing
  // is passed through unchanged, like Bash does by default.
  function expand(tree, pattern) {
    pattern = normalize(pattern);
    if (!WILDCARD.test(pattern)) return [pattern];
    let current = [""];
    for (const seg of pattern.split("/")) {
      const next = [];
      for (const base of current) {
        if (!WILDCARD.test(seg)) {
          const p = join(base, seg);
          if (tree.exists(p)) next.push(p);
          continue;
        }
        const re = segmentRegex(seg);
        for (const name of tree.children(base)) {
          // like Bash, * does not match hidden files
          if (re.test(name) && !(name.startsWith(".") && !seg.startsWith("."))) next.push(join(base, name));
        }
      }
      current = next;
    }
    return current.length ? current.sort() : [pattern];
  }

  function tokenize(command) {
    const tokens = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(command))) tokens.push(m[1] ?? m[2] ?? m[3]);
    return tokens;
  }

  function parseArgs(tokens) {
    const flags = new Set();
    const args = [];
    let endOfFlags = false;
    for (const t of tokens) {
      if (!endOfFlags && t === "--") endOfFlags = true;
      else if (!endOfFlags && t.startsWith("-") && t.length > 1) {
        for (const c of t.slice(1)) flags.add(c);
      } else args.push(t);
    }
    return { flags, args };
  }

  // Each effect: { type: "delete" | "create" | "overwrite" | "move", path, from?, before?, after? }
  function simulate(files, command) {
    const tree = new FileTree(files);
    const [name, ...rest] = tokenize(command.trim());
    const { flags, args } = parseArgs(rest);
    const recursive = flags.has("r") || flags.has("R");
    const effects = [];
    const errors = [];
    const removedDirs = [];

    const sources = (list) => list.flatMap((a) => expand(tree, a));

    if (name === "rm") {
      for (const p of sources(args)) {
        if (tree.isFile(p)) {
          effects.push({ type: "delete", path: p, before: tree.files.get(p) });
        } else if (tree.isDir(p)) {
          if (!recursive) { errors.push(`rm: ${p}: is a directory (skipped)`); continue; }
          for (const f of tree.filesUnder(p)) effects.push({ type: "delete", path: f, before: tree.files.get(f) });
          removedDirs.push(p, ...tree.dirsUnder(p));
        } else if (!flags.has("f")) {
          errors.push(`rm: ${p}: no such file`);
        }
      }
    } else if (name === "cp" || name === "mv") {
      if (args.length < 2) errors.push(`${name}: needs a source and a destination`);
      else {
        const dest = normalize(args[args.length - 1]);
        const srcs = sources(args.slice(0, -1));
        const intoDir = tree.isDir(dest) || srcs.length > 1;
        if (srcs.length > 1 && !tree.isDir(dest)) errors.push(`${name}: ${dest} is not a folder`);
        const isMove = name === "mv";

        const place = (from, to) => {
          const before = tree.files.get(to);
          const after = tree.files.get(from);
          if (isMove) effects.push({ type: "move", from, path: to, before, after });
          else effects.push({ type: before ? "overwrite" : "create", from, path: to, before, after });
        };

        for (const src of srcs) {
          const target = intoDir ? join(dest, baseName(src)) : dest;
          if (tree.isFile(src)) place(src, target);
          else if (tree.isDir(src)) {
            if (!isMove && !recursive) { errors.push(`cp: ${src} is a directory (not copied)`); continue; }
            for (const f of tree.filesUnder(src)) place(f, target + f.slice(src.length));
            if (isMove) removedDirs.push(src, ...tree.dirsUnder(src));
          } else errors.push(`${name}: ${src}: no such file`);
        }
      }
    } else if (name === "mkdir") {
      for (const a of args) {
        const p = normalize(a);
        if (tree.isDir(p)) { if (!flags.has("p")) errors.push(`mkdir: ${p}: already exists`); }
        else if (!flags.has("p") && !tree.isDir(parentOf(p))) errors.push(`mkdir: ${parentOf(p)}: no such folder (use -p)`);
        else effects.push({ type: "mkdir", path: p });
      }
    } else {
      errors.push(`This prototype only previews rm, cp, mv and mkdir (got "${name}")`);
    }

    // Final tree, so the UI can show before and after side by side.
    const afterTree = new FileTree([]);
    for (const d of tree.dirs) if (d) afterTree.addDir(d);
    for (const [p, meta] of tree.files) afterTree.addFile(p, meta);
    for (const e of effects) {
      if (e.type === "delete") afterTree.files.delete(e.path);
      if (e.type === "move") afterTree.files.delete(e.from);
    }
    for (const e of effects) {
      if (e.type === "mkdir") afterTree.addDir(e.path);
      else if (e.type !== "delete") afterTree.addFile(e.path, e.after);
    }
    // a moved or deleted folder disappears unless something new lives in it
    for (const d of removedDirs) {
      if (!afterTree.filesUnder(d).length) afterTree.dirs.delete(d);
    }

    return { command: name, effects, errors, before: tree, after: afterTree };
  }

  function summarize(result) {
    const count = (t) => result.effects.filter((e) => e.type === t).length;
    const bytes = result.effects.filter((e) => e.type === "delete" || e.type === "overwrite")
      .reduce((s, e) => s + (e.before ? e.before.size : 0), 0);
    return {
      deleted: count("delete"),
      created: count("create"),
      folders: count("mkdir"),
      overwritten: count("overwrite") + result.effects.filter((e) => e.type === "move" && e.before).length,
      moved: count("move"),
      bytesLost: bytes,
      irreversible: result.effects.some((e) => e.type === "delete" || e.before),
    };
  }

  // Paths named in the user's request. Anything changed outside them is flagged.
  function outsideScope(effect, scope) {
    if (!scope || !scope.length) return false;
    const inside = (p) => p && scope.some((s) => p === normalize(s) || p.startsWith(normalize(s) + "/"));
    if (effect.type === "delete") return !inside(effect.path);
    return !inside(effect.path) || (effect.from && !inside(effect.from));
  }

  window.Engine = { simulate, summarize, outsideScope, expand, FileTree, parentOf, baseName };
})();
