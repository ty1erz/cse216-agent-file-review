// Real plans from TritonAI models (tests/stress/plans*.json, made with
// generate_plans.py) must stay previewable. Only plans that are blocked on
// purpose are allowed to block.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { replay } = require("./stress/replay.js");

const stress = path.join(__dirname, "stress");
const files = JSON.parse(fs.readFileSync(path.join(stress, "workspace.json"), "utf8")).files;

// command fragment -> why blocking it is correct
const EXPECTED_BLOCKS = [
  ["/tmp/", "writes outside the mock home folder"],
  ["-exec bash -c", "runs an arbitrary shell script per file"],
];

for (const name of fs.readdirSync(stress).filter((f) => /^plans.*\.json$/.test(f))) {
  test(`model plans in ${name} preview unless blocked on purpose`, () => {
    const plans = JSON.parse(fs.readFileSync(path.join(stress, name), "utf8"));
    const unexpected = replay(plans, files)
      .filter((row) => row.status === "blocked")
      .filter((row) => !row.problems.some((p) => EXPECTED_BLOCKS.some(([frag]) => p.cmd.includes(frag))))
      .map((row) => `${row.plan.model} | ${row.plan.request} | ${row.problems.map((p) => `${p.cmd} -> ${p.why}`).join(" ; ")}`);
    assert.deepEqual(unexpected, []);
  });
}
