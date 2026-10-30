// Replay saved model plans through the prototype's classifier and engine and
// report every step that is blocked, skipped or fails, grouped by reason.
//
//   node tests/stress/replay.js tests/stress/plans.json [--verbose]
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");

function loadInternals() {
  const window = { SCENARIOS: [], SURVEY_CONFIG: {}, TODAY: "Fri, Oct 23, 2026" };
  const context = vm.createContext({ AbortController, DOMException, URL, clearTimeout, console, setTimeout, window });
  vm.runInContext(fs.readFileSync(path.join(root, "prototype/engine.js"), "utf8"), context);
  context.Engine = window.Engine;
  vm.runInContext(fs.readFileSync(path.join(root, "prototype/playground.js"), "utf8"), context);
  return window.Playground.internals;
}

function replay(plans, files) {
  const { simulateSequence } = loadInternals();
  const rows = [];
  for (const plan of plans) {
    if (plan.error || !plan.commands) { rows.push({ plan, status: "model-error" }); continue; }
    const sim = simulateSequence(plan.commands.map((c) => c.command).join("\n"), files);
    const problems = [];
    for (const s of sim.steps) {
      if (s.skipped) problems.push({ cmd: s.cmd, why: "skipped: " + s.skipReason });
      else if (s.cls.kind === "changes") problems.push({ cmd: s.cmd, why: "blocked: " + (s.cls.reason || "unsupported") });
      else if (s.r && s.r.blocked) problems.push({ cmd: s.cmd, why: "engine: " + s.r.errors.join("; ") });
      else if (s.r && s.r.errors.length) problems.push({ cmd: s.cmd, why: "fails: " + s.r.errors.join("; ") });
    }
    const changes = sim.steps.some((s) => s.cls.kind !== "readonly");
    rows.push({ plan, status: !changes ? "read-only" : problems.length ? "blocked" : "previewable", problems, sim });
  }
  return rows;
}

if (require.main === module) {
  const plans = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const verbose = process.argv.includes("--verbose");
  const ws = JSON.parse(fs.readFileSync(path.join(__dirname, "workspace.json"), "utf8"));
  const rows = replay(plans, ws.files);

  const count = (s) => rows.filter((r) => r.status === s).length;
  console.log(`plans: ${rows.length}  previewable: ${count("previewable")}  read-only: ${count("read-only")}  blocked: ${count("blocked")}  model errors: ${count("model-error")}`);

  // group first problem of each blocked plan by a coarse reason
  const groups = new Map();
  for (const r of rows.filter((x) => x.status === "blocked")) {
    const first = r.problems.find((p) => !p.why.startsWith("skipped")) || r.problems[0];
    const key = first.why.replace(/: .*?(rm|cp|mv|mkdir|"[^"]*"|\S+\/\S*).*$/, "").slice(0, 90);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ model: r.plan.model, request: r.plan.request, cmd: first.cmd, why: first.why });
  }
  for (const [key, items] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n[${items.length}] ${key}`);
    for (const it of items.slice(0, verbose ? 99 : 3)) console.log(`   ${it.model.padEnd(20)} ${it.cmd.slice(0, 110)}\n   ${"".padEnd(20)} -> ${it.why.slice(0, 140)}`);
  }
}

module.exports = { replay };
