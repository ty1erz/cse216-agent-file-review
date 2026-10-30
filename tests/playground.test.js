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
  assert.equal(classify('echo "rm important.txt > gone"').kind, "readonly");
  assert.equal(classify("git status --short").kind, "readonly");

  for (const command of [
    "python cleanup.py",
    "bash -c 'rm important.txt'",
    "sudo rm important.txt",
    "env rm important.txt",
    "MODE=test rm important.txt",
    "/bin/rm important.txt",
    "rm file\\ name.txt",
    "rm $TARGET",
    "rm ~/*.tmp",
    'echo "$(rm important.txt)"',
    'echo "`rm important.txt`"',
    "find . -delete",
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
  const result = simulateSequence("cat missing.txt && rm keep.txt", files);

  assert.equal(result.blocked, true);
  assert.equal(result.steps[0].success, null);
  assert.equal(result.steps[1].skipped, true);
  assert.match(result.steps[1].skipReason, /exit status/);
  assert.equal(result.finalFiles.some((file) => file.path === "keep.txt"), true);
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

