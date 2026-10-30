// Preview engine: runs a deliberately small, documented subset of rm / cp / mv /
// mkdir against a fake file tree and reports what would change. Nothing here
// touches real files. Commands outside that subset are blocked instead of being
// approximated.
//
// A tree is an array of files: { path: "docs/a.md", size: 1200, mtime: "2026-10-01" }.
// Folders are implied by paths; an empty folder is written with a trailing "/".

(function () {
  "use strict";

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

  function pathDepth(path) {
    return path ? path.split("/").length : 0;
  }

  function literalToken(value) {
    value = String(value);
    return { value, unquoted: Array(value.length).fill(false) };
  }

  function unquotedToken(value) {
    value = String(value);
    return { value, unquoted: Array(value.length).fill(true) };
  }

  // Tokenize only the shell syntax this preview understands. Quote removal and
  // backslash escaping are modeled, while operators/expansions are rejected.
  // `unquoted[i]` lets glob expansion distinguish * from "*" and \*.
  function tokenize(command) {
    const tokens = [];
    let value = "";
    let unquoted = [];
    let started = false;
    let quote = null;

    const append = (c, isUnquoted) => {
      value += c;
      unquoted.push(isUnquoted);
      started = true;
    };
    const finish = () => {
      if (!started) return;
      tokens.push({ value, unquoted });
      value = "";
      unquoted = [];
      started = false;
    };
    const unsupported = (what) => ({ tokens: [], error: `Unsupported shell syntax: ${what}` });

    for (let i = 0; i < command.length; i++) {
      const c = command[i];
      if (quote === "'") {
        if (c === "'") { quote = null; started = true; }
        else append(c, false);
        continue;
      }
      if (quote === '"') {
        if (c === '"') { quote = null; started = true; continue; }
        if (c === "\\") {
          if (i + 1 >= command.length) return unsupported("trailing backslash");
          append(command[++i], false);
          continue;
        }
        if (c === "$" || c === "`") return unsupported("expansion inside double quotes");
        append(c, false);
        continue;
      }

      if (c === "\n" || c === "\r") return unsupported("newline command separator");
      if (/\s/.test(c)) { finish(); continue; }
      if (c === "'" || c === '"') { quote = c; started = true; continue; }
      if (c === "\\") {
        if (i + 1 >= command.length) return unsupported("trailing backslash");
        append(command[++i], false);
        continue;
      }
      if (";&|<>`(){}#".includes(c) || c === "$") {
        return unsupported(`operator or expansion ${JSON.stringify(c)}`);
      }
      append(c, true);
    }

    if (quote) return unsupported("unterminated quote");
    finish();
    return { tokens, error: null };
  }

  // Resolve . and .. lexically inside the mock home. An operand may not escape
  // above that root or use an absolute path. Unquoted ~/ expands to the root.
  function normalizeToken(token) {
    let value = token.value;
    let marks = token.unquoted.slice();
    if (!value) return { error: "Empty paths are not supported" };
    if (value.startsWith("/")) return { error: `Absolute path is outside the mock home: ${value}` };
    if (value === "~" && marks[0]) {
      value = ".";
      marks = [true];
    } else if (value.startsWith("~/") && marks[0]) {
      value = value.slice(2);
      marks = marks.slice(2);
    } else if (value.startsWith("~") && marks[0]) {
      return { error: `Other home directories are not supported: ${value}` };
    }

    const segments = [];
    let part = "";
    let partMarks = [];
    const pushPart = () => {
      if (!part || part === ".") {
        part = "";
        partMarks = [];
        return null;
      }
      if (part === "..") {
        if (!segments.length) return `Path escapes the mock home: ${token.value}`;
        segments.pop();
      } else {
        segments.push({ value: part, unquoted: partMarks });
      }
      part = "";
      partMarks = [];
      return null;
    };

    for (let i = 0; i <= value.length; i++) {
      if (i === value.length || value[i] === "/") {
        const error = pushPart();
        if (error) return { error };
      } else {
        part += value[i];
        partMarks.push(marks[i] ?? false);
      }
    }

    const path = segments.map((segment) => segment.value).join("/");
    const unquoted = [];
    segments.forEach((segment, i) => {
      if (i) unquoted.push(false);
      unquoted.push(...segment.unquoted);
    });
    return { path, unquoted, segments, error: null };
  }

  function normalizeLiteral(path) {
    const normalized = normalizeToken(literalToken(path));
    if (normalized.error) throw new Error(normalized.error);
    return normalized.path;
  }

  // Lexically removing a/.. is only faithful when `a` really is a directory.
  // The fake tree has no symlinks, so require every prefix traversed by . or ..
  // to be a known directory before normalization. Dot segments mixed with globs
  // are intentionally outside the bounded subset.
  function validateDotTraversal(tree, token) {
    let value = token.value;
    let marks = token.unquoted.slice();
    if (value === "~" && marks[0]) {
      value = ".";
      marks = [true];
    } else if (value.startsWith("~/") && marks[0]) {
      value = value.slice(2);
      marks = marks.slice(2);
    }

    const segments = [];
    let part = "";
    let partMarks = [];
    for (let i = 0; i <= value.length; i++) {
      if (i === value.length || value[i] === "/") {
        if (part) segments.push({ value: part, unquoted: partMarks });
        part = "";
        partMarks = [];
      } else {
        part += value[i];
        partMarks.push(marks[i] ?? false);
      }
    }

    if (!segments.some((segment) => segment.value === "." || segment.value === "..")) return null;
    if (segments.some((segment) => segment.value !== "." && segment.value !== ".." && hasActiveGlob(segment))) {
      return `Dot segments combined with wildcards are outside the supported subset: ${token.value}`;
    }

    const current = [];
    for (const segment of segments) {
      if (segment.value === ".") {
        const prefix = current.join("/");
        if (prefix && !tree.isDir(prefix)) return `Not a folder while resolving ${token.value}: ${prefix}`;
      } else if (segment.value === "..") {
        if (!current.length) return `Path escapes the mock home: ${token.value}`;
        const prefix = current.join("/");
        if (!tree.isDir(prefix)) return `Not a folder while resolving ${token.value}: ${prefix}`;
        current.pop();
      } else {
        current.push(segment.value);
      }
    }
    return null;
  }

  class FileTree {
    constructor(files) {
      this.files = new Map();
      this.dirs = new Set([""]);
      for (const file of files) {
        const raw = String(file.path);
        if (raw.endsWith("/")) this.addDir(normalizeLiteral(raw));
        else this.addFile(normalizeLiteral(raw), file);
      }
    }

    clone() {
      const copy = new FileTree([]);
      for (const dir of this.dirs) if (dir) copy.addDir(dir);
      for (const [path, meta] of this.files) copy.addFile(path, meta);
      return copy;
    }

    addDir(path) {
      if (path === "") return;
      path = normalizeLiteral(path);
      while (path && !this.dirs.has(path)) {
        this.dirs.add(path);
        path = parentOf(path);
      }
    }

    addFile(path, meta) {
      path = normalizeLiteral(path);
      this.files.set(path, { size: meta.size || 0, mtime: meta.mtime || "", note: meta.note });
      this.addDir(parentOf(path));
    }

    isDir(path) { return this.dirs.has(path); }
    isFile(path) { return this.files.has(path); }
    exists(path) { return this.isDir(path) || this.isFile(path); }

    children(dir) {
      const out = new Set();
      const prefix = dir ? dir + "/" : "";
      for (const path of [...this.files.keys(), ...this.dirs]) {
        if (path && path.startsWith(prefix) && path !== dir) out.add(path.slice(prefix.length).split("/")[0]);
      }
      return [...out].sort();
    }

    filesUnder(dir) {
      const prefix = dir ? dir + "/" : "";
      return [...this.files.keys()].filter((path) => path.startsWith(prefix)).sort();
    }

    dirsUnder(dir) {
      const prefix = dir ? dir + "/" : "";
      return [...this.dirs].filter((path) => path && path !== dir && path.startsWith(prefix)).sort();
    }
  }

  function hasActiveGlob(token) {
    for (let i = 0; i < token.value.length; i++) {
      if (token.unquoted[i] && (token.value[i] === "*" || token.value[i] === "?" || token.value[i] === "[")) return true;
    }
    return false;
  }

  function escapeRe(c) {
    return c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function segmentRegex(segment) {
    const value = segment.value;
    const marks = segment.unquoted;
    let body = "";
    for (let i = 0; i < value.length; i++) {
      const c = value[i];
      if (marks[i] && c === "*") body += "[^/]*";
      else if (marks[i] && c === "?") body += "[^/]";
      else if (marks[i] && c === "[") {
        let close = -1;
        for (let j = i + 2; j < value.length; j++) {
          if (marks[j] && value[j] === "]") { close = j; break; }
        }
        if (close === -1 || marks.slice(i, close + 1).some((mark) => !mark)) {
          body += "\\[";
          continue;
        }
        let set = value.slice(i + 1, close);
        if (set.startsWith("!")) set = "^" + set.slice(1);
        else if (set.startsWith("^")) set = "\\^" + set.slice(1);
        body += "[" + set.replace(/\\/g, "\\\\") + "]";
        i = close;
      } else body += escapeRe(c);
    }
    try {
      return { regex: new RegExp("^" + body + "$"), error: null };
    } catch (err) {
      return { regex: null, error: `Unsupported wildcard pattern ${JSON.stringify(value)}` };
    }
  }

  // Expand unquoted *, ? and bracket patterns. A pattern matching nothing is
  // passed through unchanged, as in Bash without nullglob.
  function expandToken(tree, rawToken) {
    const traversalError = validateDotTraversal(tree, rawToken);
    if (traversalError) return { paths: [], error: traversalError };
    const normalized = normalizeToken(rawToken);
    if (normalized.error) return { paths: [], error: normalized.error };
    if (!hasActiveGlob({ value: normalized.path, unquoted: normalized.unquoted })) {
      return { paths: [normalized.path], error: null };
    }

    let current = [""];
    for (const segment of normalized.segments) {
      const next = [];
      if (!hasActiveGlob(segment)) {
        for (const base of current) {
          const path = join(base, segment.value);
          if (tree.exists(path)) next.push(path);
        }
      } else {
        const compiled = segmentRegex(segment);
        if (compiled.error) return { paths: [], error: compiled.error };
        for (const base of current) {
          for (const name of tree.children(base)) {
            if (compiled.regex.test(name) && !(name.startsWith(".") && !segment.value.startsWith("."))) {
              next.push(join(base, name));
            }
          }
        }
      }
      current = next;
      if (!current.length) break;
    }
    return { paths: current.length ? [...new Set(current)].sort() : [normalized.path], error: null };
  }

  function expand(tree, pattern) {
    const expanded = expandToken(tree, unquotedToken(pattern));
    if (expanded.error) throw new Error(expanded.error);
    return expanded.paths;
  }

  const OPTION_SPECS = {
    rm: { short: new Set(["f", "r", "R"]), long: { force: "f", recursive: "r" } },
    cp: { short: new Set(["f", "r", "R"]), long: { force: "f", recursive: "r" } },
    mv: { short: new Set(["f"]), long: { force: "f" } },
    mkdir: { short: new Set(["p"]), long: { parents: "p" } },
  };

  function parseArgs(name, tokens) {
    const spec = OPTION_SPECS[name];
    const flags = new Set();
    const args = [];
    let endOfFlags = false;
    for (const token of tokens) {
      const value = token.value;
      if (!endOfFlags && value === "--") { endOfFlags = true; continue; }
      if (!endOfFlags && value.startsWith("--") && value.length > 2) {
        const option = value.slice(2);
        if (option.includes("=") || !Object.prototype.hasOwnProperty.call(spec.long, option)) {
          return { flags, args, error: `${name}: unsupported option ${value}` };
        }
        flags.add(spec.long[option]);
        continue;
      }
      if (!endOfFlags && value.startsWith("-") && value !== "-") {
        for (const flag of value.slice(1)) {
          if (!spec.short.has(flag)) return { flags, args, error: `${name}: unsupported option -${flag}` };
          flags.add(flag === "R" ? "r" : flag);
        }
        continue;
      }
      args.push(token);
    }
    return { flags, args, error: null };
  }

  function isSameOrDescendant(path, parent) {
    return path === parent || (parent ? path.startsWith(parent + "/") : true);
  }

  function suffixUnder(path, root) {
    if (path === root) return "";
    return root ? path.slice(root.length + 1) : path;
  }

  function hasTerminalDotSegment(token) {
    const segments = token.value.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    return last === "." || last === "..";
  }

  function applyEffects(tree, effects) {
    const after = tree.clone();
    for (const effect of effects) {
      if (effect.type === "delete") after.files.delete(effect.path);
      else if (effect.type === "move") after.files.delete(effect.from);
    }
    const removedDirs = effects
      .filter((effect) => effect.type === "delete-dir" || effect.type === "move-dir")
      .map((effect) => effect.type === "move-dir" ? effect.from : effect.path)
      .filter(Boolean)
      .sort((a, b) => pathDepth(b) - pathDepth(a));
    for (const path of removedDirs) after.dirs.delete(path);

    const addedDirs = effects
      .filter((effect) => effect.type === "mkdir" || effect.type === "create-dir" || effect.type === "move-dir")
      .map((effect) => effect.path)
      .filter(Boolean)
      .sort((a, b) => pathDepth(a) - pathDepth(b));
    for (const path of addedDirs) after.addDir(path);
    for (const effect of effects) {
      if (effect.type === "create" || effect.type === "overwrite" || effect.type === "move") after.addFile(effect.path, effect.after);
    }
    return after;
  }

  function result(tree, command, effects, errors, blocked) {
    return {
      command,
      effects,
      errors,
      blocked: !!blocked,
      before: tree,
      after: blocked ? tree.clone() : applyEffects(tree, effects),
    };
  }

  function normalizeOperand(tree, token) {
    const traversalError = validateDotTraversal(tree, token);
    if (traversalError) return { error: traversalError };
    const normalized = normalizeToken(token);
    if (normalized.error) return normalized;
    return {
      ...normalized,
      activeGlob: hasActiveGlob({ value: normalized.path, unquoted: normalized.unquoted }),
      requiresDir: token.value.endsWith("/"),
    };
  }

  function simulate(files, command) {
    const tree = new FileTree(files);
    const parsed = tokenize(command.trim());
    if (parsed.error) return result(tree, "", [], [parsed.error], true);
    if (!parsed.tokens.length) return result(tree, "", [], ["Empty command"], true);

    const name = baseName(parsed.tokens[0].value);
    if (!OPTION_SPECS[name]) {
      return result(tree, name, [], [`This prototype only previews rm, cp, mv and mkdir (got "${name}")`], true);
    }
    const options = parseArgs(name, parsed.tokens.slice(1));
    if (options.error) return result(tree, name, [], [options.error], true);
    const { flags, args } = options;
    const recursive = flags.has("r");
    const effects = [];
    const errors = [];
    const effectKeys = new Set();
    const addEffect = (effect) => {
      const key = [effect.type, effect.from || "", effect.path].join("\0");
      if (!effectKeys.has(key)) { effectKeys.add(key); effects.push(effect); }
    };
    const block = (message) => result(tree, name, [], [message], true);

    const expandSources = (operands) => {
      const paths = [];
      for (const operand of operands) {
        const expanded = expandToken(tree, operand);
        if (expanded.error) return { paths: [], error: expanded.error };
        if (operand.value.endsWith("/") && expanded.paths.some((path) => !tree.isDir(path))) {
          return { paths: [], error: `Path ending in / is not a folder: ${operand.value}` };
        }
        paths.push(...expanded.paths);
      }
      return { paths, error: null };
    };

    if (name === "rm") {
      if (!args.length && !flags.has("f")) return block("rm: missing operand");
      if (args.some(hasTerminalDotSegment)) return block("rm: terminal . and .. operands are outside the supported subset");
      const expanded = expandSources(args);
      if (expanded.error) return block(expanded.error);
      if (new Set(expanded.paths).size !== expanded.paths.length) {
        return block("rm: duplicate or overlapping operands are outside the supported subset");
      }
      for (let i = 0; i < expanded.paths.length; i++) {
        for (let j = i + 1; j < expanded.paths.length; j++) {
          if ((tree.isDir(expanded.paths[i]) && isSameOrDescendant(expanded.paths[j], expanded.paths[i]))
              || (tree.isDir(expanded.paths[j]) && isSameOrDescendant(expanded.paths[i], expanded.paths[j]))) {
            return block("rm: overlapping operands are outside the supported subset");
          }
        }
      }
      for (const path of expanded.paths) {
        if (!path) return block("rm: refusing to remove the mock home itself");
        if (tree.isFile(path)) {
          addEffect({ type: "delete", kind: "file", path, before: tree.files.get(path) });
        } else if (tree.isDir(path)) {
          if (!recursive) { errors.push(`rm: ${path || "."}: is a directory (skipped)`); continue; }
          for (const file of tree.filesUnder(path)) {
            addEffect({ type: "delete", kind: "file", path: file, before: tree.files.get(file) });
          }
          const dirs = [...tree.dirsUnder(path), path].filter(Boolean).sort((a, b) => pathDepth(b) - pathDepth(a));
          for (const dir of dirs) addEffect({ type: "delete-dir", kind: "directory", path: dir });
        } else if (!flags.has("f")) {
          errors.push(`rm: ${path}: no such file or folder`);
        }
      }
      return result(tree, name, effects, errors, false);
    }

    if (name === "cp" || name === "mv") {
      if (args.length < 2) return block(`${name}: needs a source and a destination`);
      if (args.slice(0, -1).some(hasTerminalDotSegment)) {
        return block(`${name}: terminal . and .. source operands are outside the supported subset`);
      }
      const destInfo = normalizeOperand(tree, args[args.length - 1]);
      if (destInfo.error) return block(destInfo.error);
      if (destInfo.activeGlob) return block(`${name}: wildcard destinations are outside the supported subset`);
      const dest = destInfo.path;
      if (!dest) return block(`${name}: destination may not be the mock home itself`);
      if (destInfo.requiresDir && !tree.isDir(dest)) return block(`${name}: destination ${dest}/ is not an existing folder`);

      const expanded = expandSources(args.slice(0, -1));
      if (expanded.error) return block(expanded.error);
      const srcs = expanded.paths;
      if (new Set(srcs).size !== srcs.length) return block(`${name}: duplicate source operands are outside the supported subset`);
      const intoDir = tree.isDir(dest) || srcs.length > 1;
      if (srcs.length > 1 && !tree.isDir(dest)) return block(`${name}: ${dest} is not a folder`);

      for (let i = 0; i < srcs.length; i++) {
        for (let j = i + 1; j < srcs.length; j++) {
          if ((tree.isDir(srcs[i]) && isSameOrDescendant(srcs[j], srcs[i]))
              || (tree.isDir(srcs[j]) && isSameOrDescendant(srcs[i], srcs[j]))) {
            return block(`${name}: overlapping source paths are outside the supported subset`);
          }
        }
      }

      const planned = [];
      const planKeys = new Set();
      const plan = (effect) => {
        const key = [effect.type, effect.from || "", effect.path].join("\0");
        if (!planKeys.has(key)) { planKeys.add(key); planned.push(effect); }
      };
      const isMove = name === "mv";
      const targetClaims = new Map();
      const claimTarget = (path, from) => {
        if (targetClaims.has(path) && targetClaims.get(path) !== from) return false;
        targetClaims.set(path, from);
        return true;
      };

      for (const src of srcs) {
        const target = intoDir ? join(dest, baseName(src)) : dest;
        if (tree.isFile(src)) {
          if (src === target) return block(`${name}: ${src} and ${target} are the same file`);
          if (!tree.isDir(parentOf(target))) return block(`${name}: destination folder ${parentOf(target) || "."} does not exist`);
          if (tree.isDir(target)) return block(`${name}: cannot replace folder ${target} with a file`);
          if (!claimTarget(target, src)) return block(`${name}: multiple sources target ${target}`);
          const before = tree.files.get(target);
          const after = tree.files.get(src);
          plan(isMove
            ? { type: "move", kind: "file", from: src, path: target, before, after }
            : { type: before ? "overwrite" : "create", kind: "file", from: src, path: target, before, after });
          continue;
        }

        if (tree.isDir(src)) {
          if (!src) return block(`${name}: using the mock home itself as a source is outside the supported subset`);
          if (!isMove && !recursive) { errors.push(`cp: ${src}: is a directory (use -r)`); continue; }
          if (isSameOrDescendant(target, src)) return block(`${name}: cannot place ${src} inside itself (${target})`);
          if (!tree.isDir(parentOf(target))) return block(`${name}: destination folder ${parentOf(target) || "."} does not exist`);
          if (tree.isFile(target)) return block(`${name}: cannot replace file ${target} with a folder`);
          if (isMove && tree.isDir(target)) return block(`mv: destination folder ${target} already exists`);

          const sourceDirs = [src, ...tree.dirsUnder(src)];
          for (const dir of sourceDirs) {
            const mapped = suffixUnder(dir, src);
            const to = mapped ? join(target, mapped) : target;
            if (tree.isFile(to)) return block(`${name}: destination ${to} is an existing file`);
            if (!claimTarget(to, dir)) return block(`${name}: multiple sources target ${to}`);
          }
          for (const file of tree.filesUnder(src)) {
            const to = join(target, suffixUnder(file, src));
            if (tree.isDir(to)) return block(`${name}: destination ${to} is an existing folder`);
            if (!claimTarget(to, file)) return block(`${name}: multiple sources target ${to}`);
          }

          for (const dir of sourceDirs) {
            const mapped = suffixUnder(dir, src);
            const to = mapped ? join(target, mapped) : target;
            if (isMove) plan({ type: "move-dir", kind: "directory", from: dir, path: to });
            else if (!tree.isDir(to)) plan({ type: "create-dir", kind: "directory", from: dir, path: to });
          }
          for (const file of tree.filesUnder(src)) {
            const to = join(target, suffixUnder(file, src));
            const before = tree.files.get(to);
            const after = tree.files.get(file);
            plan(isMove
              ? { type: "move", kind: "file", from: file, path: to, before, after }
              : { type: before ? "overwrite" : "create", kind: "file", from: file, path: to, before, after });
          }
          continue;
        }

        errors.push(`${name}: ${src}: no such file or folder`);
      }

      for (const effect of planned) {
        for (const src of srcs) {
          if (isSameOrDescendant(effect.path, src) || isSameOrDescendant(src, effect.path)) {
            return block(`${name}: planned target ${effect.path} overlaps source ${src}`);
          }
        }
      }
      for (const effect of planned) addEffect(effect);
      return result(tree, name, effects, errors, false);
    }

    // mkdir
    if (!args.length) return block("mkdir: missing operand");
    const plannedDir = (path) => tree.isDir(path) || effects.some((effect) =>
      (effect.type === "mkdir" || effect.type === "create-dir" || effect.type === "move-dir") && effect.path === path);
    for (const operand of args) {
      const info = normalizeOperand(tree, operand);
      if (info.error) return block(info.error);
      if (info.activeGlob) return block("mkdir: wildcard operands are outside the supported subset");
      const path = info.path;
      if (!path) { errors.push("mkdir: the mock home already exists"); continue; }
      if (tree.isFile(path)) { errors.push(`mkdir: ${path}: a file already exists there`); continue; }
      if (plannedDir(path)) { if (!flags.has("p")) errors.push(`mkdir: ${path}: already exists`); continue; }

      if (flags.has("p")) {
        const parts = path.split("/");
        let current = "";
        let invalid = false;
        for (const part of parts) {
          current = join(current, part);
          if (tree.isFile(current)) { errors.push(`mkdir: ${current}: a file blocks this path`); invalid = true; break; }
        }
        if (invalid) continue;
        current = "";
        for (const part of parts) {
          current = join(current, part);
          if (!plannedDir(current)) addEffect({ type: "mkdir", kind: "directory", path: current });
        }
      } else if (!plannedDir(parentOf(path))) {
        errors.push(`mkdir: ${parentOf(path)}: no such folder (use -p)`);
      } else {
        addEffect({ type: "mkdir", kind: "directory", path });
      }
    }
    return result(tree, name, effects, errors, false);
  }

  function summarize(result) {
    const count = (type) => result.effects.filter((effect) => effect.type === type).length;
    const bytesLost = result.effects.reduce((sum, effect) => {
      if (effect.type === "delete" || effect.type === "overwrite" || (effect.type === "move" && effect.before)) {
        return sum + (effect.before ? effect.before.size : 0);
      }
      return sum;
    }, 0);
    return {
      deleted: count("delete"),
      created: count("create"),
      folders: count("mkdir") + count("create-dir"),
      foldersDeleted: count("delete-dir"),
      foldersMoved: count("move-dir"),
      overwritten: count("overwrite") + result.effects.filter((effect) => effect.type === "move" && effect.before).length,
      moved: count("move"),
      bytesLost,
      irreversible: result.effects.some((effect) => effect.type === "delete" || effect.type === "delete-dir" || effect.before),
    };
  }

  // Paths named in the user's request. Anything changed outside them is flagged.
  function outsideScope(effect, scope) {
    if (!scope || !scope.length) return false;
    const normalizedScope = scope.map((path) => {
      try { return normalizeLiteral(path); } catch (err) { return null; }
    }).filter((path) => path != null);
    const inside = (path) => path != null && normalizedScope.some((item) => path === item || path.startsWith(item ? item + "/" : ""));
    if (effect.type === "delete" || effect.type === "delete-dir") return !inside(effect.path);
    const movesSource = effect.type === "move" || effect.type === "move-dir";
    return !inside(effect.path) || (movesSource && effect.from && !inside(effect.from));
  }

  window.Engine = { simulate, summarize, outsideScope, expand, FileTree, parentOf, baseName };
})();
