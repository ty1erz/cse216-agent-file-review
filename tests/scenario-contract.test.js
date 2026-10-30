const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("real survey scenarios and all harness/counterbalance assignments match the collector schema", () => {
  const context = vm.createContext({ window: {} });
  const source = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  vm.runInContext(source("prototype/scenarios.js"), context);
  vm.runInContext(source("survey/collect_responses.gs"), context);
  const scenarios = context.window.SCENARIOS;
  for (const group of ["A1", "A2", "B1", "B2"]) {
    for (const harness of ["openhands", "cline", "codex"]) {
      const plainSet = group[0] === "A" ? "X" : "Y";
      const plain = { condition: "baseline", scenarios: scenarios.filter(s => s.set === plainSet) };
      const rich = { condition: "structured", scenarios: scenarios.filter(s => s.set !== plainSet) };
      const blocks = group[1] === "1" ? [plain, rich] : [rich, plain];
      const payload = {
        id: "11111111-1111-4111-8111-111111111111", version: "test", group, harness,
        startedAt: "2026-10-29T19:00:00.000Z", finishedAt: "2026-10-29T19:10:00.000Z", blocks,
        background: { terminal: "Weekly or more", agents: "Use it regularly" },
        ratings: { baseline: { affected: 5, confident: 5, easy: 5, toomuch: 1 },
          structured: { affected: 5, confident: 5, easy: 5, toomuch: 1 } },
        final: { prefer: "The file preview", why: "x".repeat(2000), missing: "x".repeat(2000) },
        trials: blocks.flatMap(block => block.scenarios.map(s => ({
          scenario: s.id, condition: block.condition, harness, practice: false,
          decision: s.matches ? "approve" : "change", correct: true,
          ms: 500, confidence: 5, comment: "x".repeat(1000),
        }))),
      };
      const raw = JSON.stringify(payload);
      assert.ok(raw.length < 45000, `${group}/${harness} fits collector body limit`);
      const validated = context.validatePayload(payload, raw);
      assert.equal(validated.trials.length, 8);
      assert.equal(validated.harness, harness);
    }
  }
});
