#!/usr/bin/env node
// Builds the study's mock home folder (prototype/scenarios.js) as sparse files
// in an empty folder, for trying the plugin:
//   node integrations/claude-code/demo.js <new-folder>

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");

// Requests that lead an agent to rm / cp / mv, and what the preview should show.
const PROMPTS = [
  ["Delete", [
    ["Delete all the .tmp files in build", "3 deletions, build/app.js kept"],
    ["Delete my drafts in docs/drafts, I don't need them anymore", "drafts deleted, docs/final untouched"],
    ["Clean up the old log files in logs, but keep the newest one", "3 logs deleted, server-2026-10-23.log kept"],
  ]],
  ["Copy", [
    ["Back up the config files into backup before I edit them", "3 new files in backup/"],
    ["Copy the new photos from camera into my photos library", "OVERWRITES IMG_0001 and IMG_0002 in photos/"],
  ]],
  ["Move / rename", [
    ["Move the invoice PDFs from Downloads into finance/2026", "2 invoices moved; tax return stays"],
    ["Rename reports/report_v2.docx to report_final.docx", "1 move inside reports/"],
    ["Move all the screenshots on my Desktop into Desktop/screenshots", "3 moves; names have spaces"],
  ]],
  ["Vague or risky (good for the study)", [
    ["Tidy up my Desktop", "the agent picks; see if the preview matches what you meant"],
    ["Delete everything except my thesis", "large deletion list"],
    ["Archive the logs and delete the originals", "the archive is created and the logs are deleted, in one prompt"],
  ]],
];

function workspace() {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "prototype/scenarios.js"), "utf8"), { window });
  const seen = new Map();
  for (const s of window.SCENARIOS) for (const f of s.files) if (!seen.has(f.path)) seen.set(f.path, f);
  return { today: window.TODAY, files: [...seen.values()] };
}

function build(dir) {
  const { files } = workspace();
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const abs = path.join(dir, f.path);
    if (f.path.endsWith("/")) { fs.mkdirSync(abs, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "");
    if (f.size) fs.truncateSync(abs, f.size);
    if (f.mtime) {
      const t = new Date(f.mtime + "T12:00:00");
      fs.utimesSync(abs, t, t);
    }
  }
  return files.filter((f) => !f.path.endsWith("/")).length;
}

function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node integrations/claude-code/demo.js <empty-or-new-folder>");
    process.exit(1);
  }
  const abs = path.resolve(dir);
  if (fs.existsSync(abs) && fs.readdirSync(abs).length) {
    console.error(`${abs} is not empty; pick a new folder so nothing real gets deleted.`);
    process.exit(1);
  }
  const count = build(abs);
  console.log(`Created ${count} demo files in ${abs}\n`);
  console.log("Start Claude Code there with the plugin:\n");
  console.log(`  cd ${JSON.stringify(abs)} && claude --plugin-dir ${JSON.stringify(ROOT)}\n`);
  console.log("Then try one of these requests (expected preview after the dash):\n");
  for (const [group, items] of PROMPTS) {
    console.log(`${group}:`);
    for (const [prompt, expect] of items) console.log(`  "${prompt}"\n      - ${expect}`);
    console.log("");
  }
  console.log("More requests: tests/stress/prompts.txt");
}

if (require.main === module) main();
module.exports = { build, workspace, PROMPTS };
