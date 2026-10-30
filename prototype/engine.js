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
      // A standalone {} is literal in Bash (brace expansion needs a comma or ..);
      // find -exec uses it as the path placeholder.
      if (c === "{" && command[i + 1] === "}" && !started && (i + 2 >= command.length || /\s/.test(command[i + 2]))) {
        append("{", false); append("}", false); i++;
        continue;
      }
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

  // Flags each command accepts. `alias` maps a flag onto the one it implies for
  // the mock (it has no owners, modes or timestamps to preserve, so cp -p/-a
  // only matter for what they imply). `value` flags take the next argument.
  // An agent runs without a terminal, so -i reads EOF and never overwrites:
  // the same outcome as -n.
  const OPTION_SPECS = {
    rm: { short: "frRvd", long: { force: "f", recursive: "r", verbose: "v", dir: "d" } },
    cp: {
      short: "frRvnuipat", value: "t",
      alias: { R: "r", a: "r", i: "n", p: "" },
      long: { force: "f", recursive: "r", verbose: "v", "no-clobber": "n", update: "u", interactive: "n", archive: "r", "target-directory": "t" },
    },
    mv: {
      short: "fvnuit", value: "t", alias: { i: "n" },
      long: { force: "f", verbose: "v", "no-clobber": "n", update: "u", interactive: "n", "target-directory": "t" },
    },
    mkdir: { short: "pv", long: { parents: "p", verbose: "v" } },
    rmdir: { short: "pv", long: { parents: "p", verbose: "v" } },
  };

  function parseArgs(name, tokens) {
    const spec = OPTION_SPECS[name];
    const flags = new Set();
    const values = {};
    const args = [];
    let endOfFlags = false;
    const add = (flag) => {
      const mapped = spec.alias && Object.prototype.hasOwnProperty.call(spec.alias, flag) ? spec.alias[flag] : flag;
      if (mapped) flags.add(mapped);
    };
    for (let i = 0; i < tokens.length; i++) {
      const value = tokens[i].value;
      if (!endOfFlags && value === "--") { endOfFlags = true; continue; }
      if (!endOfFlags && value.startsWith("--") && value.length > 2) {
        const [option, inline] = value.slice(2).split(/=(.*)/s);
        if (!Object.prototype.hasOwnProperty.call(spec.long, option)) {
          return { flags, values, args, error: `${name}: unsupported option ${value}` };
        }
        const flag = spec.long[option];
        if (spec.value && spec.value.includes(flag)) {
          const arg = inline != null ? { value: inline, unquoted: Array(inline.length).fill(false) } : tokens[++i];
          if (!arg) return { flags, values, args, error: `${name}: ${value} needs a value` };
          values[flag] = arg;
        } else if (inline != null) {
          return { flags, values, args, error: `${name}: unsupported option ${value}` };
        }
        add(flag);
        continue;
      }
      if (!endOfFlags && value.startsWith("-") && value !== "-") {
        const letters = value.slice(1);
        for (let j = 0; j < letters.length; j++) {
          const flag = letters[j];
          if (!spec.short.includes(flag)) return { flags, values, args, error: `${name}: unsupported option -${flag}` };
          if (spec.value && spec.value.includes(flag)) {
            const rest = letters.slice(j + 1);
            const arg = rest ? { value: rest, unquoted: tokens[i].unquoted.slice(j + 2) } : tokens[++i];
            if (!arg) return { flags, values, args, error: `${name}: -${flag} needs a value` };
            values[flag] = arg;
            add(flag);
            break;
          }
          add(flag === "R" ? "r" : flag);
        }
        continue;
      }
      args.push(tokens[i]);
    }
    return { flags, values, args, error: null };
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

  function result(tree, command, effects, errors, blocked, notes) {
    return {
      command,
      effects,
      errors,
      notes: notes || [],
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
    const tree = files instanceof FileTree ? files : new FileTree(files);
    const parsed = tokenize(command.trim());
    if (parsed.error) return result(tree, "", [], [parsed.error], true);
    if (!parsed.tokens.length) return result(tree, "", [], ["Empty command"], true);

    const name = baseName(parsed.tokens[0].value);
    if (name === "tar") return simulateTar(tree, parsed.tokens.slice(1));
    if (name === "gzip") return simulateGzip(tree, parsed.tokens.slice(1));
    if (!OPTION_SPECS[name]) {
      return result(tree, name, [], [`This prototype only previews rm, cp, mv, mkdir, rmdir and tar -c (got "${name}")`], true);
    }
    const options = parseArgs(name, parsed.tokens.slice(1));
    if (options.error) return result(tree, name, [], [options.error], true);
    const { flags, values } = options;
    let args = options.args;
    const recursive = flags.has("r");
    const effects = [];
    const errors = [];
    const notes = [];
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
          if (!recursive && flags.has("d") && !tree.children(path).length) {
            addEffect({ type: "delete-dir", kind: "directory", path });
            continue;
          }
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
      return result(tree, name, effects, errors, false, notes);
    }

    if (name === "cp" || name === "mv") {
      // -t DIR names the destination folder up front; every operand is a source.
      const destToken = values.t || args[args.length - 1];
      const sourceTokens = values.t ? args : args.slice(0, -1);
      if (!destToken || !sourceTokens.length) return block(`${name}: needs a source and a destination`);
      if (sourceTokens.some(hasTerminalDotSegment)) {
        return block(`${name}: terminal . and .. source operands are outside the supported subset`);
      }
      const destInfo = normalizeOperand(tree, destToken);
      if (destInfo.error) return block(destInfo.error);
      if (destInfo.activeGlob) return block(`${name}: wildcard destinations are outside the supported subset`);
      const dest = destInfo.path; // "" is the home folder itself, a valid target folder
      if ((destInfo.requiresDir || values.t) && !tree.isDir(dest)) return block(`${name}: destination ${dest}/ is not an existing folder`);

      const expanded = expandSources(sourceTokens);
      if (expanded.error) return block(expanded.error);
      const srcs = expanded.paths;
      if (new Set(srcs).size !== srcs.length) return block(`${name}: duplicate source operands are outside the supported subset`);
      const intoDir = tree.isDir(dest) || srcs.length > 1 || !!values.t;
      // -n never replaces an existing file; -u replaces it only with a newer one.
      const keepExisting = (from, to) => {
        const existing = tree.files.get(to);
        if (!existing) return false;
        if (flags.has("n")) return true;
        if (flags.has("u")) return !(tree.files.get(from).mtime > existing.mtime);
        return false;
      };
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
          if (keepExisting(src, target)) { notes.push(`${target} already exists, so ${src} is skipped`); continue; }
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
            if (keepExisting(file, to)) { notes.push(`${to} already exists, so ${file} is skipped`); continue; }
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
      return result(tree, name, effects, errors, false, notes);
    }

    if (name === "rmdir") {
      if (!args.length) return block("rmdir: missing operand");
      const expanded = expandSources(args);
      if (expanded.error) return block(expanded.error);
      const removed = new Set();
      // Empty once everything planned for removal inside it is gone.
      const isEmpty = (dir) => tree.children(dir).every((child) => removed.has(join(dir, child)));
      const removeDir = (path) => {
        if (!path) { errors.push("rmdir: refusing to remove the mock home itself"); return false; }
        if (tree.isFile(path)) { errors.push(`rmdir: ${path}: not a folder`); return false; }
        if (!tree.isDir(path)) { errors.push(`rmdir: ${path}: no such folder`); return false; }
        if (!isEmpty(path)) { errors.push(`rmdir: ${path}: folder not empty`); return false; }
        removed.add(path);
        addEffect({ type: "delete-dir", kind: "directory", path });
        return true;
      };
      for (const path of expanded.paths) {
        if (!removeDir(path) || !flags.has("p")) continue;
        for (let parent = parentOf(path); parent; parent = parentOf(parent)) if (!removeDir(parent)) break;
      }
      return result(tree, name, effects, errors, false, notes);
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
    return result(tree, name, effects, errors, false, notes);
  }

  // ---------- today (for find -mtime / -newermt and new files' dates) ----------

  let todayMs = Date.UTC(2026, 9, 23);
  function setToday(text) {
    const d = new Date(String(text));
    if (!Number.isNaN(d.getTime())) todayMs = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  }
  const todayIso = () => new Date(todayMs).toISOString().slice(0, 10);
  const dayMs = (iso) => { const t = Date.parse(String(iso) + "T00:00:00Z"); return Number.isNaN(t) ? null : t; };

  // Quote a value for the engine's tokenizer only when needed: 'it'\''s' -> it's
  function quote(value) {
    value = String(value);
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
    return "'" + value.replace(/'/g, "'\\''") + "'";
  }

  // ---------- tar -c ----------

  // Only archive creation: it adds one file and never changes its inputs. The
  // archive's size is unknown without compressing, so it is estimated.
  function simulateTar(tree, tokens) {
    const block = (message) => result(tree, "tar", [], [message], true);
    let letters = "";
    let archive = null;
    const operands = [];
    for (let i = 0; i < tokens.length; i++) {
      const v = tokens[i].value;
      const isFirstBundle = i === 0 && /^[cxtrudzjJvf]+$/.test(v);
      if (v.startsWith("--")) return block(`tar: unsupported option ${v}`);
      if (v.startsWith("-") || isFirstBundle) {
        const bundle = v.replace(/^-/, "");
        for (let j = 0; j < bundle.length; j++) {
          const c = bundle[j];
          if (!"czjJvf".includes(c)) return block(c === "x" || c === "t" ? "tar: only creating archives (-c) can be previewed" : `tar: unsupported option -${c}`);
          letters += c;
          if (c === "f") {
            archive = bundle.slice(j + 1) ? { value: bundle.slice(j + 1), unquoted: tokens[i].unquoted.slice(-bundle.slice(j + 1).length) } : tokens[++i];
            break;
          }
        }
        continue;
      }
      operands.push(tokens[i]);
    }
    if (!letters.includes("c")) return block("tar: only creating archives (-c) can be previewed");
    if (!archive) return block("tar: -f ARCHIVE is required in this prototype");
    if (!operands.length) return block("tar: nothing to archive");

    const target = normalizeOperand(tree, archive);
    if (target.error) return block(target.error);
    if (target.activeGlob || !target.path) return block("tar: invalid archive path");
    if (tree.isDir(target.path)) return block(`tar: ${target.path} is a folder`);
    if (!tree.isDir(parentOf(target.path))) return block(`tar: folder ${parentOf(target.path) || "."} does not exist`);

    let size = 0;
    const errors = [];
    for (const operand of operands) {
      const expanded = expandToken(tree, operand);
      if (expanded.error) return block(expanded.error);
      for (const path of expanded.paths) {
        if (tree.isFile(path)) size += tree.files.get(path).size || 0;
        else if (tree.isDir(path)) for (const f of tree.filesUnder(path)) size += tree.files.get(f).size || 0;
        else errors.push(`tar: ${path}: no such file or folder`);
      }
    }
    const before = tree.files.get(target.path);
    const after = { size, mtime: todayIso(), note: "archive, size estimated" };
    const effect = { type: before ? "overwrite" : "create", kind: "file", from: operands.map((o) => o.value).join(" "), path: target.path, before, after };
    return result(tree, "tar", [effect], errors, false, ["The archive's size is estimated from its contents; the original files are kept."]);
  }

  // ---------- gzip ----------

  // gzip FILE replaces FILE with FILE.gz (-k keeps the original). The
  // compressed size is unknown, so the new file keeps the original's size.
  function simulateGzip(tree, tokens) {
    const block = (message) => result(tree, "gzip", [], [message], true);
    const flags = new Set();
    const operands = [];
    for (const token of tokens) {
      if (token.value.startsWith("-") && token.value !== "-") {
        for (const c of token.value.slice(1)) {
          if (!/[kvf1-9]/.test(c)) return block(`gzip: unsupported option -${c}`);
          flags.add(c);
        }
      } else operands.push(token);
    }
    if (!operands.length) return block("gzip: compressing standard input is outside the supported subset");
    const effects = [], errors = [];
    for (const operand of operands) {
      const expanded = expandToken(tree, operand);
      if (expanded.error) return block(expanded.error);
      for (const path of expanded.paths) {
        if (tree.isDir(path)) { errors.push(`gzip: ${path} is a folder (skipped)`); continue; }
        if (!tree.isFile(path)) { errors.push(`gzip: ${path}: no such file`); continue; }
        if (path.endsWith(".gz")) { errors.push(`gzip: ${path} already has .gz suffix (unchanged)`); continue; }
        const target = path + ".gz";
        const before = tree.files.get(target);
        if (before && !flags.has("f")) { errors.push(`gzip: ${target} already exists (unchanged)`); continue; }
        const after = { ...tree.files.get(path), note: "compressed, size estimated" };
        effects.push(flags.has("k")
          ? { type: before ? "overwrite" : "create", kind: "file", from: path, path: target, before, after }
          : { type: "move", kind: "file", from: path, path: target, before, after });
      }
    }
    return result(tree, "gzip", effects, errors, false, ["Compressed sizes are estimated; gzip's real output is smaller."]);
  }

  // ---------- find ----------

  // Wildcard match for find -name / -path, where every character is active and
  // -path's * also matches "/".
  function fnmatchRegex(pattern, crossSlash, ignoreCase) {
    let body = "";
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === "*") body += crossSlash ? ".*" : "[^/]*";
      else if (c === "?") body += crossSlash ? "." : "[^/]";
      else if (c === "[") {
        const close = pattern.indexOf("]", i + 2);
        if (close === -1) { body += "\\["; continue; }
        let set = pattern.slice(i + 1, close);
        if (set.startsWith("!")) set = "^" + set.slice(1);
        body += "[" + set.replace(/\\/g, "\\\\") + "]";
        i = close;
      } else if (c === "\\" && i + 1 < pattern.length) body += escapeRe(pattern[++i]);
      else body += escapeRe(c);
    }
    return new RegExp("^" + body + "$", ignoreCase ? "i" : "");
  }

  const FIND_EXEC_COMMANDS = new Set(["rm", "mv", "cp", "rmdir", "mkdir"]);
  const FIND_EXEC_READONLY = new Set(["ls", "echo", "stat", "du", "wc", "file", "cat", "head", "tail"]);

  // Parse `find START... EXPRESSION` into starts and an expression tree.
  function parseFind(tokens) {
    let i = 0;
    const starts = [];
    while (i < tokens.length && !/^[-!(),]/.test(tokens[i].value)) starts.push(tokens[i++]);
    if (!starts.length) starts.push(unquotedToken("."));
    const opts = { maxdepth: Infinity, mindepth: 0, depthFirst: false };
    let hasAction = false;
    let mutates = false;
    const ex = tokens.slice(i);
    let p = 0;
    const fail = (msg) => { throw new Error(msg); };
    const next = () => ex[p++];
    const need = (what) => { const t = next(); if (!t) fail(`find: ${what} needs a value`); return t.value; };
    const num = (v, what) => { if (!/^[+-]?\d+$/.test(v)) fail(`find: bad number for ${what}: ${v}`); return v; };
    const cmp = (spec, actual) => {
      const n = Number(spec.replace(/^[+-]/, ""));
      return spec.startsWith("+") ? actual > n : spec.startsWith("-") ? actual < n : actual === n;
    };

    function primary() {
      const t = next();
      if (!t) fail("find: incomplete expression");
      const v = t.value;
      if (v === "(") { const e = orExpr(); const close = next(); if (!close || close.value !== ")") fail("find: missing )"); return e; }
      if (v === "!" || v === "-not") { const e = primary(); return (en) => !e(en); }
      switch (v) {
        case "-maxdepth": opts.maxdepth = Number(num(need(v), v)); return () => true;
        case "-mindepth": opts.mindepth = Number(num(need(v), v)); return () => true;
        case "-depth": opts.depthFirst = true; return () => true;
        case "-xdev": case "-mount": case "-follow": return () => true;
        case "-true": return () => true;
        case "-false": return () => false;
        case "-name": case "-iname": { const re = fnmatchRegex(need(v), false, v === "-iname"); return (en) => re.test(en.name); }
        case "-path": case "-ipath": case "-wholename": case "-iwholename": {
          const re = fnmatchRegex(need(v), true, v.startsWith("-i"));
          return (en) => re.test(en.printed);
        }
        case "-type": {
          const kind = need(v);
          if (!/^[fd](,[fd])*$/.test(kind)) fail(`find: -type ${kind} is outside the supported subset`);
          return (en) => kind.split(",").includes(en.isDir ? "d" : "f");
        }
        case "-empty": return (en) => en.isDir ? !en.tree.children(en.path).length : (en.meta.size || 0) === 0;
        case "-mtime": {
          const spec = num(need(v), v);
          return (en) => { const t = en.isDir ? null : dayMs(en.meta.mtime); return t != null && cmp(spec, Math.floor((todayMs - t) / 864e5)); };
        }
        case "-newermt": {
          const raw = String(need(v)).trim();
          const ref = Date.parse(raw.length <= 10 ? raw + "T00:00:00Z" : raw.replace(" ", "T") + "Z");
          if (Number.isNaN(ref)) fail("find: -newermt needs a date like 2026-10-22");
          // the mock only knows the day a file changed; count it as midday
          return (en) => { const t = en.isDir ? null : dayMs(en.meta.mtime); return t != null && t + 432e5 > ref; };
        }
        case "-newer": {
          const ref = need(v);
          return (en) => { const other = en.tree.files.get(normalizeLiteral(ref)); return !!other && !en.isDir && en.meta.mtime > other.mtime; };
        }
        case "-size": {
          const m = /^([+-]?)(\d+)([ckMG]?)$/.exec(need(v));
          if (!m) fail("find: bad -size value");
          const unit = { "": 512, c: 1, k: 1024, M: 1048576, G: 1073741824 }[m[3]];
          const spec = m[1] + m[2];
          return (en) => !en.isDir && cmp(spec, Math.ceil((en.meta.size || 0) / unit));
        }
        case "-print": case "-print0": case "-ls": hasAction = true; return (en) => { en.out.print.push(en.path); return true; };
        case "-printf": need(v); hasAction = true; return (en) => { en.out.print.push(en.path); return true; };
        case "-delete": hasAction = true; mutates = true; opts.depthFirst = true; return (en) => { en.out.delete.push(en); return true; };
        case "-exec": {
          const argv = [];
          let terminator = null;
          for (let t2 = next(); t2; t2 = next()) {
            if (t2.value === ";" || (t2.value === "+" && argv.length && argv[argv.length - 1].value === "{}")) { terminator = t2.value; break; }
            if (t2.value !== "{}" && t2.value.includes("{}")) fail("find: {} inside a word is outside the supported subset");
            argv.push(t2);
          }
          if (!terminator) fail("find: -exec must end with \\; or {} +");
          const cmd = baseName(argv.length ? argv[0].value : "");
          if (!argv.some((a) => a.value === "{}")) fail("find: -exec without {} is outside the supported subset");
          if (FIND_EXEC_READONLY.has(cmd)) { hasAction = true; return (en) => { en.out.print.push(en.path); return true; }; }
          if (!FIND_EXEC_COMMANDS.has(cmd)) fail(`find: -exec ${cmd || "(nothing)"} is outside the supported subset`);
          hasAction = true; mutates = true;
          const group = { argv, plus: terminator === "+", paths: [] };
          execs.push(group);
          return (en) => { group.paths.push(en.path); return true; };
        }
        default:
          fail(`find: ${v} is outside the supported subset`);
      }
      return null;
    }
    function andExpr() {
      let left = primary();
      while (p < ex.length && ex[p].value !== ")" && ex[p].value !== "-o" && ex[p].value !== "-or" && ex[p].value !== ",") {
        if (ex[p].value === "-a" || ex[p].value === "-and") p++;
        const l = left, r = primary();
        left = (en) => l(en) && r(en);
      }
      return left;
    }
    function orExpr() {
      let left = andExpr();
      while (p < ex.length && (ex[p].value === "-o" || ex[p].value === "-or")) {
        p++;
        const l = left, r = andExpr();
        left = (en) => l(en) || r(en);
      }
      return left;
    }

    const execs = [];
    try {
      const expr = ex.length ? orExpr() : () => true;
      if (p < ex.length) fail(`find: unexpected ${ex[p].value}`);
      return { starts, expr, opts, hasAction, mutates, execs, error: null };
    } catch (err) {
      return { error: err.message };
    }
  }

  // Evaluate find against the tree. Returns the printed paths, the paths -delete
  // removes (deepest first) and each -exec group, or an error.
  function runFind(files, command, options) {
    const tree = files instanceof FileTree ? files : new FileTree(files);
    const parsed = tokenize(command.trim());
    if (parsed.error) return { error: parsed.error };
    if (!parsed.tokens.length || baseName(parsed.tokens[0].value) !== "find") return { error: "not a find command" };
    const spec = parseFind(parsed.tokens.slice(1));
    if (spec.error) return { error: spec.error };
    if (options && options.syntaxOnly) return { readonly: !spec.mutates, error: null };

    const out = { print: [], delete: [] };
    const missing = [];
    for (const startToken of spec.starts) {
      const info = normalizeOperand(tree, startToken);
      if (info.error) return { error: info.error };
      if (info.activeGlob) return { error: "find: wildcard start paths are outside the supported subset" };
      const start = info.path;
      if (!tree.exists(start)) { missing.push(start || "."); continue; }
      const shown = startToken.value.replace(/\/+$/, "") || ".";
      const visit = (path, depth) => {
        const isDir = tree.isDir(path);
        const rel = suffixUnder(path, start);
        const entry = { path, isDir, depth, tree, out, meta: tree.files.get(path) || {}, name: path ? baseName(path) : shown, printed: rel ? `${shown}/${rel}` : shown };
        const evalHere = () => {
          if (depth < spec.opts.mindepth || depth > spec.opts.maxdepth) return;
          if (spec.expr(entry) && !spec.hasAction) out.print.push(path);
        };
        if (!spec.opts.depthFirst) evalHere();
        if (isDir && depth < spec.opts.maxdepth) for (const child of tree.children(path)) visit(join(path, child), depth + 1);
        if (spec.opts.depthFirst) evalHere();
      };
      visit(start, 0);
    }
    if (out.delete.some((en) => !en.path) || spec.execs.some((g) => g.paths.includes(""))) {
      return { error: "find: an action on the mock home itself is outside the supported subset" };
    }

    // Turn the actions into the exact simple commands find would run.
    const commands = [];
    for (const en of out.delete) commands.push(en.isDir ? `rmdir ${quote(en.path)}` : `rm ${quote(en.path)}`);
    for (const group of spec.execs) {
      const render = (paths) => group.argv.map((a) => a.value === "{}" ? paths.map(quote).join(" ") : quote(a.value)).join(" ");
      if (group.plus) { if (group.paths.length) commands.push(render(group.paths)); }
      else for (const path of group.paths) commands.push(render([path]));
    }
    return {
      readonly: !spec.mutates,
      printed: out.print,
      commands,
      errors: missing.map((m) => `find: ${m}: no such file or folder`),
      error: null,
    };
  }

  // ---------- for loops ----------

  // Split on unquoted separators; returns [{ text, sep }] where sep is the
  // separator that ended the piece (";", "&&", "\n" or "").
  function splitUnquoted(text, seps) {
    const parts = [];
    let cur = "", q = null, esc = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (esc) { cur += c; esc = false; continue; }
      if (c === "\\" && q !== "'") { cur += c; esc = true; continue; }
      if (q) { if (c === q) q = null; cur += c; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      const sep = seps.find((s) => text.startsWith(s, i));
      if (sep) { parts.push({ text: cur, sep }); cur = ""; i += sep.length - 1; continue; }
      cur += c;
    }
    parts.push({ text: cur, sep: "" });
    return parts;
  }

  // Replace $VAR, ${VAR}, ${VAR##*/}, ${VAR%.*}, ${VAR%/*} and $(basename|dirname "$VAR" [suffix])
  // with the loop value, quoted for where it appears. Any other $ is unsupported.
  function substituteVar(body, name, value) {
    const forms = [
      [new RegExp(`^\\$\\{${name}\\}`), () => value],
      // ${VAR//from/to} and ${VAR/from/to} with literal text (no wildcards)
      [new RegExp(`^\\$\\{${name}(//?)([^/}*?\\[\\\\]+)/([^}$\`\\\\]*)\\}`), (m) =>
        m[1] === "//" ? value.split(m[2]).join(m[3]) : value.replace(m[2], m[3])],
      [new RegExp(`^\\$\\{${name}##\\*/\\}`), () => baseName(value)],
      [new RegExp(`^\\$\\{${name}%/\\*\\}`), () => parentOf(value) || "."],
      [new RegExp(`^\\$\\{${name}%\\.\\*\\}`), () => value.replace(/\.[^./]*$/, "")],
      [new RegExp(`^\\$\\(\\s*basename\\s+("?)\\$\\{?${name}\\}?\\1(?:\\s+("?)([^\\s"()]+)\\2)?\\s*\\)`), (m) => {
        const base = baseName(value);
        return m[3] && base.endsWith(m[3]) && base !== m[3] ? base.slice(0, -m[3].length) : base;
      }],
      [new RegExp(`^\\$\\(\\s*dirname\\s+("?)\\$\\{?${name}\\}?\\1\\s*\\)`), () => parentOf(value) || "."],
      [new RegExp(`^\\$${name}(?![A-Za-z0-9_])`), () => value],
    ];
    let out = "", q = null;
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (q === "'") { out += c; if (c === "'") q = null; continue; }
      if (c === "\\" && i + 1 < body.length) { out += c + body[++i]; continue; }
      if (c === "'" && !q) { q = "'"; out += c; continue; }
      if (c === '"') { q = q === '"' ? null : '"'; out += c; continue; }
      if (c === "$") {
        const rest = body.slice(i);
        const form = forms.find(([re]) => re.test(rest));
        if (!form) return { error: "for loop: only the loop variable can be expanded in its body" };
        const m = form[0].exec(rest);
        const v = form[1](m);
        out += q === '"' ? v.replace(/[\\"$`]/g, "\\$&") : quote(v);
        i += m[0].length - 1;
        continue;
      }
      out += c;
    }
    return { text: out, error: null };
  }

  // Unroll `for VAR in WORDS; do BODY; done` into the commands it would run.
  // WORDS are expanded once against the tree, as Bash does before the loop.
  function unrollFor(files, text) {
    const tree = files instanceof FileTree ? files : new FileTree(files);
    const pieces = splitUnquoted(text.trim(), ["\n", ";"]).map((p) => p.text.trim()).filter(Boolean);
    const head = /^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.*?)(?:\s+do)?$/s.exec(pieces[0] || "");
    if (!head) return { error: "for loop: expected for VAR in WORDS; do ...; done" };
    let i = 1;
    if (!/\sdo$/.test(pieces[0])) {
      if (!/^do(\s|$)/.test(pieces[1] || "")) return { error: "for loop: missing do" };
      pieces[1] = pieces[1].replace(/^do\s*/, "");
      if (!pieces[1]) i = 2;
    }
    if (pieces[pieces.length - 1] !== "done") return { error: "for loop: missing done" };
    const bodyPieces = pieces.slice(i, -1);
    if (!bodyPieces.length) return { error: "for loop: empty body" };
    if (bodyPieces.some((b) => /^(for|while|until|if|case|done|then|fi)\b/.test(b))) {
      return { error: "for loop: nested loops and conditionals are outside the supported subset" };
    }

    const words = tokenize(head[2]);
    if (words.error) return { error: words.error.replace("Unsupported shell syntax", "for loop list") };
    const values = [];
    for (const token of words.tokens) {
      const expanded = expandToken(tree, token);
      if (expanded.error) return { error: expanded.error };
      values.push(...expanded.paths);
    }

    const iterations = [];
    for (const value of values) {
      const steps = [];
      for (const piece of bodyPieces) {
        for (const [k, part] of splitUnquoted(piece, ["&&"]).entries()) {
          const sub = substituteVar(part.text.trim(), head[1], value);
          if (sub.error) return { error: sub.error };
          steps.push({ cmd: sub.text, connector: k ? "&&" : ";" });
        }
      }
      iterations.push(steps);
    }
    return { variable: head[1], values, iterations, error: null };
  }

  // Run several simple commands in order as one previewed step, honoring &&
  // inside each group. Returns a merged result for the review screens.
  function simulateMany(files, groups) {
    const start = files instanceof FileTree ? files : new FileTree(files);
    let tree = start;
    const effects = [], errors = [], notes = [], ran = [];
    let blocked = false;
    for (const steps of groups) {
      let ok = true;
      for (const step of steps) {
        if (step.connector === "&&" && !ok) continue;
        const r = simulate(tree, step.cmd);
        ran.push(step.cmd);
        if (r.blocked) { blocked = true; errors.push(...r.errors.map((e) => `${step.cmd}: ${e}`)); ok = false; break; }
        effects.push(...r.effects);
        errors.push(...r.errors);
        notes.push(...r.notes);
        ok = !r.errors.length;
        tree = r.after;
      }
      if (blocked) break;
    }
    return { command: "", effects, errors, notes, ran, blocked, before: start, after: blocked ? start.clone() : tree };
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

  window.Engine = {
    simulate, simulateMany, runFind, unrollFor, setToday, quote,
    summarize, outsideScope, expand, FileTree, parentOf, baseName,
  };
})();
