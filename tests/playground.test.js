const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

function loadInternals(fetchImpl = async () => ({ ok: true, status: 200, text: async () => "{}" })) {
  const window = {
    SCENARIOS: [],
    SURVEY_CONFIG: { agentUrl: "https://proxy.example.test" },
    TODAY: "Fri, Oct 23, 2026",
  };
  const context = vm.createContext({
    AbortController,
    DOMException,
    URL,
    clearTimeout,
    console,
    fetch: fetchImpl,
    setTimeout,
    window,
  });
  vm.runInContext(fs.readFileSync(path.join(root, "prototype/engine.js"), "utf8"), context, { filename: "engine.js" });
  context.Engine = window.Engine;
  vm.runInContext(fs.readFileSync(path.join(root, "prototype/playground.js"), "utf8"), context, { filename: "playground.js" });
  return window.Playground.internals;
}

test("classifier only permits simulated mutations and explicit read-only commands", () => {
  const { classify } = loadInternals();

  assert.equal(classify('rm "file with spaces.txt"').kind, "previewable");
  // The engine tokenizes escapes and a leading ~/ exactly, so these are previewed.
  assert.equal(classify("rm file\\ name.txt").kind, "previewable");
  assert.equal(classify("mv Desktop/Screenshot\\ 2026-10-21*.png Desktop/screenshots/").kind, "previewable");
  assert.equal(classify("rm ~/*.tmp").kind, "previewable");
  assert.equal(classify('echo "rm important.txt > gone"').kind, "readonly");
  assert.equal(classify("git status --short").kind, "readonly");

  for (const command of [
    "python cleanup.py",
    "bash -c 'rm important.txt'",
    "sudo rm important.txt",
    "env rm important.txt",
    "MODE=test rm important.txt",
    "/bin/rm important.txt",
    "rm $TARGET",
    'echo "$(rm important.txt)"',
    'echo "`rm important.txt`"',
    "find . -exec bash -c 'rm \"$1\"' _ {} \\;",
    "find . -name '*.tmp' | xargs rm",
    "rg --pre 'python cleanup.py' needle",
    "git clean -fd",
    "git diff --ext-diff",
    "git show --textconv HEAD:file",
    "git diff --output=changes.patch",
    "sort input.txt -o output.txt",
    "cat input.txt > output.txt",
  ]) {
    assert.equal(classify(command).kind, "changes", command);
  }
});

test("command parsing preserves conditional and unconditional separators", () => {
  const { parseCommandSequence } = loadInternals();
  const parsed = parseCommandSequence('rm "draft;a.txt" && cp source target; mv old new\nmkdir done');

  assert.equal(parsed.length, 4);
  assert.equal(parsed[0].cmd, 'rm "draft;a.txt"');
  assert.equal(parsed[0].connector, null);
  assert.equal(parsed[1].connector, "&&");
  assert.equal(parsed[2].connector, ";");
  assert.equal(parsed[3].connector, ";");

  assert.match(parseCommandSequence("rm draft.txt &&").parseError, /ends with &&/);
  assert.match(parseCommandSequence("; rm draft.txt").parseError, /empty step/);
});

test("failed command stops an && chain and blocks approval", () => {
  const { simulateSequence } = loadInternals();
  const files = [{ path: "keep.txt", size: 1 }];
  const result = simulateSequence("rm missing.txt && rm keep.txt", files);

  assert.equal(result.blocked, true);
  assert.equal(result.steps[0].success, false);
  assert.equal(result.steps[1].skipped, true);
  assert.equal(result.finalFiles.some((file) => file.path === "keep.txt"), true);
});

test("semicolon continues after failure but the overall plan remains blocked", () => {
  const { simulateSequence } = loadInternals();
  const files = [{ path: "keep.txt", size: 1 }];
  const result = simulateSequence("rm missing.txt; rm keep.txt", files);

  assert.equal(result.blocked, true);
  assert.equal(result.steps[0].success, false);
  assert.equal(result.steps[1].success, true);
  assert.equal(result.finalFiles.some((file) => file.path === "keep.txt"), false);
});

test("steps after an unsupported mutation are not misleadingly simulated", () => {
  const { simulateSequence } = loadInternals();
  const files = [{ path: "keep.txt", size: 1 }];
  const result = simulateSequence("python cleanup.py; rm keep.txt", files);

  assert.equal(result.blocked, true);
  assert.equal(result.steps[0].cls.kind, "changes");
  assert.equal(result.steps[1].skipped, true);
  assert.equal(result.finalFiles.some((file) => file.path === "keep.txt"), true);
});

test("known-success read-only steps can precede a faithfully simulated change", () => {
  const { simulateSequence } = loadInternals();
  const files = [{ path: "remove.txt", size: 1 }];
  const result = simulateSequence("true && rm remove.txt", files);

  assert.equal(result.blocked, false);
  assert.equal(result.steps[0].cls.kind, "readonly");
  assert.equal(result.steps[1].success, true);
  assert.equal(result.finalFiles.some((file) => file.path === "remove.txt"), false);
});

test("unknown read-only exit status cannot control a destructive && step", () => {
  const { simulateSequence } = loadInternals();
  const files = [{ path: "keep.txt", size: 1 }];
  // grep's exit status depends on file contents the mock does not have
  const result = simulateSequence("grep -q needle keep.txt && rm keep.txt", files);

  assert.equal(result.blocked, true);
  assert.equal(result.steps[0].success, null);
  assert.equal(result.steps[1].skipped, true);
  assert.match(result.steps[1].skipReason, /exit status/);
  assert.equal(result.finalFiles.some((file) => file.path === "keep.txt"), true);
});

test("read-only steps that read paths succeed exactly when the paths exist", () => {
  const { simulateSequence } = loadInternals();
  const files = [{ path: "keep.txt", size: 1 }, { path: "old/a.txt", size: 2 }];

  const missing = simulateSequence("cat missing.txt && rm keep.txt", files);
  assert.equal(missing.steps[0].success, false);
  assert.match(missing.steps[1].skipReason, /previous command failed/);
  assert.equal(missing.blocked, true);

  const present = simulateSequence("ls old && rm -r old", files);
  assert.equal(present.blocked, false);
  assert.equal(present.finalFiles.some((file) => file.path.startsWith("old")), false);

  const fallback = simulateSequence("rmdir old 2>/dev/null || rm -r old", files);
  assert.equal(fallback.steps[1].skipped, undefined);
  assert.equal(fallback.finalFiles.some((file) => file.path.startsWith("old")), false);
});

test("[ ] and test file checks decide which branch runs", () => {
  const { simulateSequence, readonlyStatus } = loadInternals();
  const files = [{ path: "a.txt", size: 3 }, { path: "empty.txt", size: 0 }, { path: "dir/b.txt", size: 1 }];

  assert.equal(readonlyStatus("[ -e a.txt ]", files), true);
  assert.equal(readonlyStatus("[ -e missing ]", files), false);
  assert.equal(readonlyStatus("[ ! -e missing ]", files), true);
  assert.equal(readonlyStatus("[ -d dir ]", files), true);
  assert.equal(readonlyStatus("[ -f dir ]", files), false);
  assert.equal(readonlyStatus("test -s empty.txt", files), false);
  assert.equal(readonlyStatus('test -f "a.txt"', files), true);
  // Outside the bounded subset: stays unknown rather than guessed.
  for (const command of ["[ -e *.txt ]", "[ -e a.txt", "[ -n x ]", "[ -e a.txt -a -e b ]", "[ -e /etc/hosts ]"]) {
    assert.equal(readonlyStatus(command, files), null, command);
  }

  const guarded = simulateSequence('[ -e b.txt ] && echo "exists" || mv -n a.txt b.txt', files);
  assert.equal(guarded.steps[1].skipped, true);
  assert.equal(guarded.finalFiles.some((file) => file.path === "b.txt"), true);
  const kept = simulateSequence('[ -e a.txt ] && echo "exists" || mv dir/b.txt a.txt', files);
  assert.equal(kept.steps[2].skipped, true);
  assert.equal(kept.finalFiles.some((file) => file.path === "dir/b.txt"), true);
});

test("request coordinator invalidates and aborts stale work", () => {
  const { createRequestCoordinator } = loadInternals();
  const requests = createRequestCoordinator();
  const first = requests.start();
  const second = requests.start();

  assert.equal(first.signal.aborted, true);
  assert.equal(requests.isCurrent(first), false);
  assert.equal(requests.isCurrent(second), true);
  requests.invalidate();
  assert.equal(second.signal.aborted, true);
  assert.equal(requests.isCurrent(second), false);
});

test("malformed model plans become visible model errors", () => {
  const { normalizePlan } = loadInternals();

  assert.equal(normalizePlan(null).error, "model_error");
  assert.equal(normalizePlan({ commands: {} }).error, "model_error");
  assert.equal(normalizePlan({ commands: [null] }).error, "model_error");
  assert.deepEqual(
    JSON.parse(JSON.stringify(normalizePlan({ reply: "ok", commands: [{ command: " rm draft.txt ", purpose: "clean" }] }))),
    { commands: [{ command: "rm draft.txt", purpose: "clean" }], model: "", refused: false, reply: "ok" },
  );
});

test("model proxy timeout returns an actionable error", async () => {
  const hangingFetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
  const { askAgent } = loadInternals(hangingFetch);
  const result = await askAgent("remove a file", [], { timeoutMs: 5 });

  assert.equal(result.error, "timeout");
});


test("find and for loops are previewed as the exact commands they run", () => {
  const { classify, simulateSequence } = loadInternals();
  const files = [
    { path: "logs/a.log", size: 1, mtime: "2026-10-18" },
    { path: "logs/b.log", size: 2, mtime: "2026-10-23" },
    { path: "logs/keep.txt", size: 3, mtime: "2026-10-01" },
    { path: "pics/Shot 1.png", size: 4 },
    { path: "pics/Shot 2.png", size: 5 },
    { path: "empty/" },
  ];

  assert.equal(classify("find logs -name '*.log' -print").kind, "readonly");
  assert.equal(classify("find logs -name '*.log' | sort").kind, "readonly");

  // -mtime +2: older than two whole days before Oct 23
  const old = simulateSequence("find logs -name '*.log' -mtime +2 -delete", files);
  assert.equal(old.blocked, false);
  assert.deepEqual(Array.from(old.finalFiles, (f) => f.path).filter((p) => p.startsWith("logs/")).sort(), ["logs/b.log", "logs/keep.txt"]);

  const exec = simulateSequence("mkdir done && find pics -type f -exec mv {} done/ \\;", files);
  assert.equal(exec.blocked, false);
  assert.equal(exec.steps[1].r.ran.length, 2);

  const loop = simulateSequence('for f in pics/*.png; do\n  mv "$f" "${f// /_}"\ndone', files);
  assert.equal(loop.steps.length, 1);
  assert.equal(loop.blocked, false);
  assert.deepEqual(Array.from(loop.finalFiles, (f) => f.path).filter((p) => p.startsWith("pics/")).sort(), ["pics/Shot_1.png", "pics/Shot_2.png"]);

  // deleting everything, the home folder included, stays blocked
  assert.equal(simulateSequence("find . -delete", files).blocked, true);
  // loop bodies may only use the loop variable
  assert.equal(simulateSequence('for f in pics/*; do mv "$f" "$DEST"; done', files).blocked, true);
});

test("loop bodies keep || and evaluate [ ] checks per iteration", () => {
  const { parseCommandSequence, simulateSequence } = loadInternals();
  const grouped = parseCommandSequence('for f in a b; do [ -e "x_$f" ] && echo skip || mv "$f" "x_$f"; done');
  assert.equal(grouped.length, 1);
  assert.match(grouped[0].cmd, /echo skip \|\| mv/);

  const files = [{ path: "a", size: 1 }, { path: "b", size: 2 }, { path: "x_b", size: 3 }];
  const r = simulateSequence('for f in a b; do [ -e "x_$f" ] && echo skip || mv "$f" "x_$f"; done', files);
  assert.equal(r.blocked, false);
  const paths = Array.from(r.finalFiles, (f) => f.path).sort();
  // a is renamed; b is kept because x_b already exists.
  assert.deepEqual(paths, ["b", "x_a", "x_b"]);
});

test("read-only verification after a change does not block it", () => {
  const { simulateSequence } = loadInternals();
  const files = [{ path: "c/a.yaml", size: 1 }, { path: "backup/" }];
  const r = simulateSequence("cp c/a.yaml backup/ && cmp c/a.yaml backup/a.yaml && echo VERIFIED", files);
  assert.equal(r.blocked, false);
  assert.equal(r.steps[2].harmless, true);
  // A change whose running depends on an unknown status still blocks.
  assert.equal(simulateSequence("cmp c/a.yaml backup/a.yaml && rm c/a.yaml", files).blocked, true);
});
