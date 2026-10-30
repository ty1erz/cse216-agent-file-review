const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");

function loadContext() {
  const context = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "prototype/engine.js"), "utf8"), context);
  return context;
}

function snapshot(tree) {
  return {
    dirs: [...tree.dirs].sort(),
    files: [...tree.files.keys()].sort(),
  };
}

function effectPaths(result, type) {
  const paths = [];
  for (const effect of result.effects) if (effect.type === type) paths.push(effect.path);
  return paths.sort();
}

test("resolves dot segments without allowing paths above the mock home", () => {
  const Engine = loadContext().window.Engine;
  const files = [{ path: "docs/" }, { path: "private/secret.txt", size: 10 }];

  const normalized = Engine.simulate(files, "rm docs/../private/secret.txt");
  assert.equal(normalized.blocked, false);
  assert.deepEqual(effectPaths(normalized, "delete"), ["private/secret.txt"]);
  assert.equal(normalized.after.isFile("private/secret.txt"), false);

  for (const command of [
    "rm ../../private/secret.txt",
    "rm /private/secret.txt",
    'rm "/private/secret.txt"',
    "rm -r .",
    "rm -r docs/.",
    "rm -r docs/..",
    "rm missing/../private/secret.txt",
    "rm private/secret.txt/../other.txt",
    "rm private/secret.txt/.",
  ]) {
    const result = Engine.simulate(files, command);
    assert.equal(result.blocked, true, command);
    assert.equal(result.effects.length, 0, command);
    assert.deepEqual(snapshot(result.after), snapshot(result.before), command);
  }
});

test("blocks duplicate, overlapping and converging cp/mv sources", () => {
  const Engine = loadContext().window.Engine;
  const files = [
    { path: "x/a.txt", size: 1 },
    { path: "y/a.txt", size: 2 },
    { path: "dir/file.txt", size: 3 },
    { path: "x/d/file.txt", size: 4, note: "X" },
    { path: "dest/d/file.txt", size: 5, note: "OLD" },
    { path: "dest/" },
  ];
  const commands = [
    "mv x/a.txt y/a.txt dest/",
    "cp x/a.txt y/a.txt dest/",
    "mv dir dir/file.txt dest/",
    "mv x/a.txt x/a.txt dest/",
    "rm x/a.txt x/a.txt",
    "rm -r dir dir/file.txt",
    "cp -r x/d dest/d/file.txt dest/",
  ];

  for (const command of commands) {
    const result = Engine.simulate(files, command);
    assert.equal(result.blocked, true, command);
    assert.equal(result.effects.length, 0, command);
    assert.deepEqual(snapshot(result.after), snapshot(result.before), command);
  }
});

test("only unquoted wildcards expand", () => {
  const Engine = loadContext().window.Engine;
  const files = [
    { path: "build/*.tmp", size: 1 },
    { path: "build/a.tmp", size: 2 },
    { path: "build/b.txt", size: 3 },
  ];

  const quoted = Engine.simulate(files, 'rm "build/*.tmp"');
  assert.deepEqual(effectPaths(quoted, "delete"), ["build/*.tmp"]);
  assert.equal(quoted.after.isFile("build/a.tmp"), true);

  const escaped = Engine.simulate(files, "rm build/\\*.tmp");
  assert.deepEqual(effectPaths(escaped, "delete"), ["build/*.tmp"]);

  const expanded = Engine.simulate(files, "rm build/*.tmp");
  assert.deepEqual(effectPaths(expanded, "delete"), ["build/*.tmp", "build/a.tmp"]);
});

test("blocks shell syntax and options outside the supported subset", () => {
  const Engine = loadContext().window.Engine;
  const files = [{ path: "a.txt", size: 1 }, { path: "src/file.txt", size: 2 }];
  const commands = [
    "rm -i a.txt",
    "cp --no-preserve=mode src copy",
    "rm a.txt | cat",
    "rm $(printf a.txt)",
    "rm [z-a]",
  ];

  for (const command of commands) {
    const result = Engine.simulate(files, command);
    assert.equal(result.blocked, true, command);
    assert.equal(result.effects.length, 0, command);
    assert.deepEqual(snapshot(result.after), snapshot(result.before), command);
  }
});

test("invalid multi-source destinations produce no effects", () => {
  const Engine = loadContext().window.Engine;
  const files = [{ path: "a.txt", size: 1 }, { path: "b.txt", size: 2 }];

  for (const command of ["cp a.txt b.txt missing", "mv a.txt b.txt missing"]) {
    const result = Engine.simulate(files, command);
    assert.equal(result.blocked, true, command);
    assert.equal(result.effects.length, 0, command);
    assert.deepEqual(snapshot(result.after), snapshot(result.before), command);
  }
});

test("a trailing slash requires an existing directory", () => {
  const Engine = loadContext().window.Engine;
  const files = [{ path: "source.txt", size: 1 }, { path: "target/" }];

  const valid = Engine.simulate(files, "cp source.txt target/");
  assert.equal(valid.blocked, false);
  assert.deepEqual(effectPaths(valid, "create"), ["target/source.txt"]);

  for (const command of ["cp source.txt missing/", "mv source.txt missing/", "rm source.txt/"]) {
    const result = Engine.simulate(files, command);
    assert.equal(result.blocked, true, command);
    assert.equal(result.effects.length, 0, command);
    assert.deepEqual(snapshot(result.after), snapshot(result.before), command);
  }
});

test("prevents copying or moving a folder into itself", () => {
  const Engine = loadContext().window.Engine;
  const files = [{ path: "docs/a.txt", size: 1 }, { path: "dest/" }];

  for (const command of [
    "mv docs docs/archive",
    "cp -r docs docs/archive",
    "mv docs docs",
    "cp -r docs/. dest/",
    "cp -r docs/.. dest/",
    "mv docs/. dest/",
    "mv docs/.. dest/",
  ]) {
    const result = Engine.simulate(files, command);
    assert.equal(result.blocked, true, command);
    assert.equal(result.effects.length, 0, command);
    assert.deepEqual(snapshot(result.after), snapshot(result.before), command);
  }
});

test("represents empty directory deletion, copy and move as effects", () => {
  const Engine = loadContext().window.Engine;

  const removed = Engine.simulate([{ path: "empty/" }], "rm -r empty");
  assert.deepEqual(effectPaths(removed, "delete-dir"), ["empty"]);
  assert.equal(removed.after.isDir("empty"), false);
  assert.equal(Engine.summarize(removed).foldersDeleted, 1);

  const copied = Engine.simulate([{ path: "src/empty/" }], "cp -r src copy");
  assert.deepEqual(effectPaths(copied, "create-dir"), ["copy", "copy/empty"]);
  assert.equal(copied.after.isDir("copy/empty"), true);

  const moved = Engine.simulate([{ path: "src/empty/" }], "mv src moved");
  assert.deepEqual(effectPaths(moved, "move-dir"), ["moved", "moved/empty"]);
  assert.equal(moved.after.isDir("src"), false);
  assert.equal(moved.after.isDir("moved/empty"), true);
});

test("counts bytes replaced by cp and mv overwrites", () => {
  const Engine = loadContext().window.Engine;
  const files = [{ path: "src.txt", size: 5 }, { path: "dest.txt", size: 100 }];

  const copied = Engine.simulate(files, "cp src.txt dest.txt");
  assert.equal(copied.blocked, false);
  assert.equal(Engine.summarize(copied).overwritten, 1);
  assert.equal(Engine.summarize(copied).bytesLost, 100);

  const moved = Engine.simulate(files, "mv src.txt dest.txt");
  assert.equal(moved.blocked, false);
  assert.equal(Engine.summarize(moved).overwritten, 1);
  assert.equal(Engine.summarize(moved).bytesLost, 100);
});

test("scope checks a copy target but also checks a move source", () => {
  const Engine = loadContext().window.Engine;
  const files = [{ path: "source.txt", size: 1 }, { path: "dest/" }];

  const copied = Engine.simulate(files, "cp source.txt dest/");
  assert.equal(Engine.outsideScope(copied.effects[0], ["dest"]), false);

  const moved = Engine.simulate(files, "mv source.txt dest/");
  assert.equal(Engine.outsideScope(moved.effects[0], ["dest"]), true);
});

test("mkdir -p reports every directory it creates", () => {
  const Engine = loadContext().window.Engine;
  const result = Engine.simulate([], "mkdir -p a/b/c");
  assert.equal(result.blocked, false);
  assert.deepEqual(effectPaths(result, "mkdir"), ["a", "a/b", "a/b/c"]);
  assert.equal(result.after.isDir("a/b/c"), true);
});

test("mkdir operands observe directories created earlier in the same command", () => {
  const Engine = loadContext().window.Engine;
  const result = Engine.simulate([], "mkdir a a/b");
  assert.equal(result.blocked, false);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(effectPaths(result, "mkdir"), ["a", "a/b"]);
  assert.equal(result.after.isDir("a/b"), true);

  const duplicate = Engine.simulate([], "mkdir a a");
  assert.deepEqual(effectPaths(duplicate, "mkdir"), ["a"]);
  assert.match(duplicate.errors.join(" "), /already exists/);
});

test("all committed study scenarios remain in the supported subset", () => {
  const context = loadContext();
  vm.runInContext(fs.readFileSync(path.join(ROOT, "prototype/scenarios.js"), "utf8"), context);

  for (const scenario of [context.window.PRACTICE, ...context.window.SCENARIOS]) {
    const result = context.window.Engine.simulate(scenario.files, scenario.command);
    assert.equal(result.blocked, false, `${scenario.id}: ${result.errors.join("; ")}`);
  }
});
