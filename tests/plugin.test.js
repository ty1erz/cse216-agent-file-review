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
const { reviewCommand, shortPath } = require("../integrations/core/review.js");
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

test("previews a guarded rename like the ones Claude writes", () => {
  const dir = workspace({ "reports/report_v2.docx": "v2", "reports/report_v1.docx": "v1" });
  const command = `cd ${dir}/reports && ls -la && [ -e report_final.docx ] && echo "TARGET EXISTS" || mv -n report_v2.docx report_final.docx && ls -la`;
  const r = reviewCommand(command, os.homedir());
  assert.equal(r.status, "preview");
  assert.match(r.text, /report_v2\.docx -> report_final\.docx/);
  assert.doesNotMatch(r.text, /Partly|Could not/);
  // The target exists, so the mv branch never runs and nothing changes.
  const taken = reviewCommand(`cd ${dir}/reports && [ -e report_v1.docx ] && echo exists || mv report_v2.docx report_v1.docx`, dir);
  assert.equal(taken.effects.length, 0);
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

test("keeps the header path short", () => {
  assert.equal(shortPath("/Users/me/proj", "/Users/me"), "~/proj");
  assert.equal(shortPath("/Users/me", "/Users/me"), "~");
  assert.equal(shortPath("/srv/app", "/Users/me"), "/srv/app");
  assert.equal(shortPath("/private/tmp/claude-501/some-very-long-session-id/scratchpad/live-test", "/Users/me"), "…/scratchpad/live-test");
  const dir = workspace({ "a.txt": "a" });
  assert.match(reviewCommand("rm a.txt", dir).text.split("\n")[0], /^File change preview \(in .{1,45}\)$/);
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

test("the demo folder previews the overwrite it promises", () => {
  const { build } = require("../integrations/claude-code/demo.js");
  const dir = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "file-review-demo-"))), "home");
  assert.ok(build(dir) > 40);
  assert.equal(fs.statSync(path.join(dir, "photos/IMG_0001.jpg")).size > 1e6, true);
  const r = reviewCommand("cp camera/*.jpg photos/", dir);
  assert.match(r.text, /OVERWRITE 2 files/);
  assert.match(r.text, /\+ photos\/IMG_0003\.jpg/);
});

test("~ means the real home folder, never the working folder", () => {
  // Before this fix `rm -f ~/x` was read as `rm -f <cwd>/x`, found nothing and
  // produced no prompt at all.
  const dir = workspace({ "notes.txt": "n" });
  const out = decide(bash("rm -f ~/notes.txt", dir));
  assert.ok(out, "a command touching the home folder must not pass silently");
  assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /Could not preview/);
  assert.doesNotMatch(out.hookSpecificOutput.permissionDecisionReason, /notes\.txt {2}\d/);
});

test("absolute paths with globs preview like relative ones", () => {
  const dir = workspace({ "build/a.tmp": "1", "build/b.tmp": "2", "build/app.js": "3" });
  const r = reviewCommand(`rm ${dir}/build/*.tmp`, dir);
  assert.equal(r.status, "preview");
  assert.match(r.text, /DELETE 2 files/);
  const quoted = reviewCommand(`cp "${dir}/build/app.js" "${dir}/build/app copy.js"`, path.join(dir, "build"));
  assert.equal(quoted.status, "preview", quoted.text);
  assert.match(quoted.text, /\+ app copy\.js/);
  // The parent folder is outside the working folder, so it is refused.
  assert.equal(reviewCommand(`cp "${dir}/build/app.js" "${dir}"`, path.join(dir, "build")).status, "unpreviewable");
});

test("common agent habits are understood", () => {
  const dir = workspace({ "Downloads/invoice_04.pdf": "a", "Downloads/invoice_05.pdf": "b", "Downloads/tax.pdf": "t",
    "finance/2026/": "", "reports/v2.docx": "r", "build/x.tmp": "x", "logs/a.log": "1", "logs/b.log": "2" });
  const cases = [
    ["mv Downloads/invoice_0{4,5}.pdf finance/2026/", /MOVE 2 files/],
    ["for f in logs/{a,b}.log; do rm \"$f\"; done", /DELETE 2 files/],
    ["if [ ! -e reports/final.docx ]; then mv reports/v2.docx reports/final.docx; fi", /v2\.docx -> reports\/final\.docx/],
    ["cd build && rm -f *.tmp && cd ..", /DELETE 1 file/],
    ["rm -rf build/ dist/", /DELETE 1 file/],
  ];
  for (const [command, expected] of cases) {
    const r = reviewCommand(command, dir);
    assert.equal(r.status, "preview", `${command}\n${r.text}`);
    assert.match(r.text, expected, command);
    assert.doesNotMatch(r.text, /Partly/, command);
  }
  // Left alone, so the engine refuses rather than guesses.
  assert.equal(reviewCommand("if [ -d build ]; then rm -r build; else echo no; fi", dir).status, "unpreviewable");
  assert.equal(reviewCommand("rm logs/{a..b}.log", dir).status, "unpreviewable");
  assert.equal(reviewCommand('rm "logs/{a,b}.log"', dir).effects.length, 0);
});
