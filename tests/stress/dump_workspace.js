// Print the prototype's "home folder" workspace (all scenario files) as JSON.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
const window = {};
vm.runInNewContext(fs.readFileSync(path.join(root, "prototype/scenarios.js"), "utf8"), { window });
const seen = new Map();
for (const s of window.SCENARIOS) for (const f of s.files) if (!seen.has(f.path)) seen.set(f.path, f);
process.stdout.write(JSON.stringify({ today: window.TODAY, files: [...seen.values()] }, null, 1));
