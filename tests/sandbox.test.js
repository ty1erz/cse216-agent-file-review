// Dry-run path of the plugin: the before/after diff on any system, and real
// sandboxed runs where macOS sandbox-exec is available.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { diff, retarget, available } = require("../integrations/core/sandbox.js");
const { reviewCommand } = require("../integrations/core/review.js");

const entry = (ino, size = 1, dir = false, mtime = "1") => ({ ino: String(ino), size, mtime, dir });
const kinds = (effects) => effects.map((e) => [e.type, e.from || null, e.path]).sort((a, b) => a[2].localeCompare(b[2]));

test("diff tells moves, overwrites, deletes and creates apart by inode", () => {
  const before = new Map([["a", entry(1)], ["b", entry(2)], ["c", entry(3, 5)], ["d", entry(4)], ["dir", entry(9, 0, true)], ["dir/x", entry(10)]]);
  const after = new Map([["b", entry(1)], ["c", entry(3, 7, false, "2")], ["e", entry(5)], ["new", entry(9, 0, true)], ["new/x", entry(10)]]);
  assert.deepEqual(kinds(diff(before, after)), [
    ["move", "a", "b"],
    ["overwrite", null, "c"],
    ["delete", null, "d"],
    ["create", null, "e"],
    ["move-dir", "dir", "new"],
  ]);
  const moved = diff(before, after).find((e) => e.type === "move");
  assert.equal(moved.before.size, 1, "b existed before, so the move overwrites it");
});

test("diff shows gzip and gunzip as one step", () => {
  const z = diff(new Map([["a.log", entry(1)]]), new Map([["a.log.gz", entry(2)]]));
  assert.deepEqual(kinds(z), [["move", "a.log", "a.log.gz"]]);
  const u = diff(new Map([["a.log.gz", entry(1)]]), new Map([["a.log", entry(2)]]));
  assert.deepEqual(kinds(u), [["move", "a.log.gz", "a.log"]]);
});

test("retarget points absolute paths at the clone", () => {
  assert.equal(retarget('rm "/w/proj/a b" /w/proj/c; cd /w/proj && ls /w/project', "/w/proj", "/tmp/c"),
    'rm "/tmp/c/a b" /tmp/c/c; cd /tmp/c && ls /w/project');
});

const darwin = available() ? test : test.skip;

function workspace(files) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "file-review-sbx-")));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    if (rel.endsWith("/")) { fs.mkdirSync(abs, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

darwin("a dry run previews commands the simulator cannot, and never touches the real folder", () => {
  const dir = workspace({ "logs/a.log": "1", "logs/b.log": "22", "backup/": "", "notes.txt": "TODO keep\n", "old.txt": "drop\n" });
  const listing = () => fs.readdirSync(dir, { recursive: true }).sort();
  const before = listing();

  const sub = reviewCommand("cd logs && tar -czf ../backup/logs.tgz *.log && rm *.log", dir);
  assert.equal(sub.mode, "dry-run");
  assert.match(sub.text, /DELETE 2 files/);
  assert.match(sub.text, /\+ backup\/logs\.tgz/);

  // Depends on file contents: only a real run knows which file matches.
  const grep = reviewCommand("grep -L TODO *.txt | xargs rm", dir);
  assert.match(grep.text, /- old\.txt/);
  assert.doesNotMatch(grep.text, /notes\.txt/);

  const loop = reviewCommand('for f in logs/*.log; do mv "$f" "$(echo "$f" | sed s/log$/txt/)"; done', dir);
  assert.match(loop.text, /logs\/a\.log -> logs\/a\.txt/);

  assert.deepEqual(listing(), before);
});

darwin("writes outside the folder or slow commands fall back to the simulator", () => {
  const dir = workspace({ "a.txt": "a" });
  const outside = reviewCommand(`touch ${os.homedir()}/file-review-escape-test && rm a.txt`, dir);
  assert.equal(outside.mode === "dry-run", false);
  assert.match(outside.text, /Dry run not possible \(the command writes outside the working folder\)/);
  assert.equal(fs.existsSync(path.join(os.homedir(), "file-review-escape-test")), false);

  const slow = reviewCommand("sleep 6 && rm a.txt", dir);
  assert.match(slow.text, /took longer than/);
  assert.ok(fs.existsSync(path.join(dir, "a.txt")));
});

darwin("a leading cd picks the folder, and temp scratch writes are redirected", () => {
  const dir = workspace({ "logs/a.log": "1", "logs/b.log": "2", "backup/": "" });
  const scratch = path.join(os.tmpdir(), `file-review-scratch-${process.pid}`, "verify");
  // The agent's shell is still in logs/ from an earlier step; the command
  // cds to the parent, archives, verifies in a temp folder and deletes.
  const command = `cd ${dir} && tar -czf backup/logs.tgz -C logs a.log b.log && mkdir -p ${scratch} `
    + `&& tar -xzf backup/logs.tgz -C ${scratch} && cmp logs/a.log ${scratch}/a.log && rm logs/*.log`;
  const r = reviewCommand(command, path.join(dir, "logs"));
  assert.equal(r.mode, "dry-run", r.text);
  assert.match(r.text, /DELETE 2 files/);
  assert.match(r.text, /\+ backup\/logs\.tgz/);
  assert.match(r.text, /temporary folders/);
  assert.equal(fs.existsSync(scratch), false, "the real temp folder is never written");
  assert.ok(fs.existsSync(path.join(dir, "logs", "a.log")));
});

darwin("any write outside the folder falls back, whatever the command prints", () => {
  const dir = workspace({ "a.txt": "a" });
  // tar reports "Failed to open", not "Operation not permitted".
  const r = reviewCommand(`tar -czf ${os.homedir()}/file-review-escape.tgz a.txt && rm a.txt`, dir);
  assert.notEqual(r.mode, "dry-run");
  assert.match(r.text, /writes outside the working folder/);
  assert.equal(fs.existsSync(path.join(os.homedir(), "file-review-escape.tgz")), false);
});
