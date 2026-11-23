#!/usr/bin/env node
// Ask real Claude Code to carry out each request in tests/stress/prompts.txt,
// each in a fresh demo folder with the plugin loaded, and record every Bash
// command it tries and what the plugin did with it.
//
//   node tests/stress/run_claude_code.js <out-dir> [--jobs 4] [--only delete,copy] [--model sonnet] [--prompts file.txt]
//
// Headless (-p) runs cannot answer the plugin's "ask", so reviewed commands are
// refused and the demo folders stay unchanged; read-only commands still run.
// Uses your Claude Code login and counts toward its usage.
// Summarize afterwards with: node tests/stress/run_claude_code.js <out-dir> --report

"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const { build } = require(path.join(ROOT, "integrations/claude-code/demo.js"));

function readPrompts(only, file = path.join(__dirname, "prompts.txt")) {
  const out = [];
  let section = "";
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const text = line.trim();
    if (!text) continue;
    if (text.startsWith("#")) { section = text.slice(1).trim().split(/\s+/)[0]; continue; }
    if (!only || only.includes(section)) out.push({ section, prompt: text });
  }
  return out;
}

function runOne(item, i, outDir, model) {
  const id = String(i + 1).padStart(2, "0");
  const dir = path.join(outDir, "work", id);
  fs.rmSync(dir, { recursive: true, force: true });
  build(dir);
  const log = path.join(outDir, `${id}.jsonl`);
  fs.rmSync(log, { force: true });
  const args = ["-p", "--plugin-dir", ROOT, "--max-turns", "8", "--no-session-persistence"];
  if (model) args.push("--model", model);
  args.push(item.prompt);
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd: dir, env: { ...process.env, FILE_REVIEW_LOG: log }, stdio: ["ignore", "pipe", "pipe"] });
    let reply = "";
    child.stdout.on("data", (d) => { reply += d; });
    child.stderr.on("data", (d) => { reply += d; });
    const timer = setTimeout(() => child.kill("SIGTERM"), 180000);
    child.on("close", (code) => {
      clearTimeout(timer);
      fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify({ id, ...item, code, reply }, null, 1));
      process.stderr.write(`${id} ${item.section.padEnd(8)} exit ${code}  ${item.prompt}\n`);
      resolve();
    });
  });
}

function report(outDir) {
  const rows = [];
  for (const file of fs.readdirSync(outDir).filter((f) => /^\d+\.json$/.test(f)).sort()) {
    const meta = JSON.parse(fs.readFileSync(path.join(outDir, file), "utf8"));
    const log = path.join(outDir, `${meta.id}.jsonl`);
    const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    rows.push({ ...meta, calls });
  }
  const tally = {};
  for (const row of rows) for (const c of row.calls) tally[c.status] = (tally[c.status] || 0) + 1;
  console.log(`${rows.length} requests, ${rows.reduce((s, r) => s + r.calls.length, 0)} Bash commands:`, tally);
  // Commands that change files but are not reviewed are the plugin's blind spot.
  // Quoted text and redirects to /dev/null are ignored, so `2>/dev/null` and
  // echo "a > b" do not count as writes.
  const WRITERS = /(^|[;&|(]\s*|\bdo\s+|\bthen\s+)(rsync|git\s+(mv|rm)|install|ln|touch|truncate|tee|sed\s+-i|perl\s+-i|python3?|node|zip|unzip|tar|dd|chmod|chown|trash|osascript|rmdir|mkdir|gzip|gunzip)\b/;
  const plain = (cmd) => cmd.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''").replace(/\d?>>?\s*\/dev\/null|\d?>&\d/g, "");
  const writes = (cmd) => WRITERS.test(plain(cmd)) || /(^|[^<\d&])>>?\s*[^&\s]/.test(plain(cmd));
  for (const row of rows) {
    const odd = row.calls.filter((c) => c.status === "unpreviewable" || (c.status === "skip" && writes(c.command)));
    if (!odd.length) continue;
    console.log(`\n${row.id} [${row.section}] ${row.prompt}`);
    for (const c of odd) {
      console.log(`  ${c.status === "skip" ? "NOT REVIEWED" : "CANNOT PREVIEW"}: ${c.command.replace(/\n/g, "\n      ")}`);
      if (c.status !== "skip") console.log(`      ${c.text.split("\n").filter((l) => /Could not|Partly/.test(l)).join(" ")}`);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const outDir = argv[0] && path.resolve(argv[0]);
  if (!outDir) { console.error("usage: node tests/stress/run_claude_code.js <out-dir> [--jobs N] [--only sections] [--model m] | --report"); process.exit(1); }
  const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
  if (argv.includes("--report")) return report(outDir);
  const jobs = Number(flag("--jobs") || 4);
  const only = flag("--only") ? flag("--only").split(",") : null;
  const items = readPrompts(only, flag("--prompts") ? path.resolve(flag("--prompts")) : undefined);
  fs.mkdirSync(outDir, { recursive: true });
  let next = 0;
  await Promise.all(Array.from({ length: jobs }, async () => {
    while (next < items.length) { const i = next++; await runOne(items[i], i, outDir, flag("--model")); }
  }));
  report(outDir);
}

main();
