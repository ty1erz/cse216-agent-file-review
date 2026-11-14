// The Claude Code plugin runs the prototype engine against a snapshot of a real
// folder. These tests build temporary folders and check the hook's decisions;
// no test deletes anything outside its own temp folder, and the hook never
// changes files at all.

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const { reviewCommand } = require("../integrations/core/review.js");
const { decide } = require("../integrations/claude-code/pretooluse.js");

function workspace(files) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "file-review-")));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    if (rel.endsWith("/")) { fs.mkdirSync(abs, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

function listing(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) walk(path.join(abs, e.name), r); else out.push(r);
    }
  };
  walk(dir, "");
  return out.sort();
}

const bash = (command, cwd) => ({ tool_name: "Bash", tool_input: { command }, cwd });

test("ignores commands that are not rm, cp or mv", () => {
  const dir = workspace({ "a.txt": "a" });
  for (const command of ["ls -la", "git mv a.txt b.txt", 'echo "rm -rf a.txt"', "npm run rm", "mkdir out", 'git commit -m "mv files"']) {
    assert.equal(reviewCommand(command, dir).status, "skip", command);
    assert.equal(decide(bash(command, dir)), null, command);
  }
  assert.equal(decide({ tool_name: "Edit", tool_input: {}, cwd: dir }), null);
});

test("lists every file rm -r would delete, with sizes, and changes nothing", () => {
  const dir = workspace({ "build/app.js": "x".repeat(2048), "build/maps/app.js.map": "m", "src/main.js": "s", "debug.log": "d" });
  const before = listing(dir);
  const out = decide(bash("rm -rf build *.log", dir));
  assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
  const text = out.hookSpecificOutput.permissionDecisionReason;
  assert.match(text, /DELETE 3 files/);
  assert.match(text, /build\/app\.js {2}2\.0 KB/);
  assert.match(text, /build\/maps\/app\.js\.map/);
  assert.match(text, /debug\.log/);
  assert.doesNotMatch(text, /src\/main\.js/);
  assert.deepEqual(listing(dir), before);
});

test("flags cp overwrites and mv destinations", () => {
  const dir = workspace({ "notes/a.md": "new", "docs/a.md": "old contents", "x.txt": "x", "archive/": "" });
  const cp = reviewCommand("cp notes/a.md docs/", dir);
  assert.equal(cp.status, "preview");
  assert.match(cp.text, /OVERWRITE 1 file/);
  assert.match(cp.text, /docs\/a\.md {2}\(12 B, replaced by notes\/a\.md\)/);

  const mv = reviewCommand("mv x.txt archive/", dir);
  assert.match(mv.text, /x\.txt -> archive\/x\.txt/);
});

test("handles a leading cd and absolute paths inside the folder", () => {
  const dir = workspace({ "proj/tmp/a.tmp": "a", "proj/keep.txt": "k" });
  const viaCd = reviewCommand(`cd ${dir}/proj && rm tmp/a.tmp`, os.homedir());
  assert.equal(viaCd.status, "preview");
  assert.match(viaCd.text, /tmp\/a\.tmp/);

  const abs = reviewCommand(`rm "${dir}/proj/keep.txt"`, path.join(dir, "proj"));
  assert.equal(abs.status, "preview");
  assert.match(abs.text, /- keep\.txt/);
});

test("asks with a warning when the command cannot be previewed", () => {
  const dir = workspace({ "a.txt": "a" });
  for (const command of ["rm $(cat list.txt)", "rm /etc/hosts", "find . -name '*.txt' | xargs rm"]) {
    const out = decide(bash(command, dir));
    assert.equal(out.hookSpecificOutput.permissionDecision, "ask", command);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /Could not preview|Partly previewed/, command);
  }
  const strict = decide(bash("rm $(cat list.txt)", dir), { FILE_REVIEW_STRICT: "1" });
  assert.equal(strict.hookSpecificOutput.permissionDecision, "deny");
});

test("previews find -delete and for loops by expanding them", () => {
  const dir = workspace({ "a.tmp": "1", "sub/b.tmp": "2", "c.txt": "3" });
  const find = reviewCommand("find . -name '*.tmp' -delete", dir);
  assert.equal(find.status, "preview");
  assert.match(find.text, /DELETE 2 files/);

  const loop = reviewCommand("for f in *.txt; do mv \"$f\" \"$f.bak\"; done", dir);
  assert.equal(loop.status, "preview");
  assert.match(loop.text, /c\.txt -> c\.txt\.bak/);
});

test("FILE_REVIEW_COMMANDS widens or narrows what is reviewed", () => {
  const dir = workspace({ "a.txt": "a" });
  assert.equal(reviewCommand("mkdir out", dir, { env: { FILE_REVIEW_COMMANDS: "rm,cp,mv,mkdir" } }).status, "preview");
  assert.equal(reviewCommand("cp a.txt b.txt", dir, { env: { FILE_REVIEW_COMMANDS: "rm" } }).status, "skip");
});

test("skips folders like node_modules unless the command names them", () => {
  const dir = workspace({ "node_modules/pkg/index.js": "x", "a.txt": "a" });
  const star = reviewCommand("rm -r *", dir);
  assert.match(star.text, /contents of node_modules were not scanned/);
  const named = reviewCommand("rm -r node_modules", dir);
  assert.match(named.text, /node_modules\/pkg\/index\.js/);
});

test("the hook script speaks Claude Code's stdin/stdout protocol", () => {
  const dir = workspace({ "a.txt": "a" });
  const script = path.join(ROOT, "integrations/claude-code/pretooluse.js");
  const run = (input) => execFileSync(process.execPath, [script], { input: JSON.stringify(input), encoding: "utf8" });
  const out = JSON.parse(run({ hook_event_name: "PreToolUse", ...bash("rm a.txt", dir) }));
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
  assert.equal(run(bash("ls", dir)), "");
  assert.equal(execFileSync(process.execPath, [script], { input: "not json", encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }), "");
  assert.ok(fs.existsSync(path.join(dir, "a.txt")));
});
