#!/usr/bin/env node
// Claude Code PreToolUse hook for Bash: answers "ask" with a file preview for
// reviewed commands, and prints nothing for the rest.

"use strict";

const fs = require("node:fs");
const { reviewCommand } = require("../core/review.js");

function evaluate(input, env = process.env) {
  if (!input || input.tool_name !== "Bash") return { review: null, output: null };
  const command = input.tool_input && input.tool_input.command;
  const review = reviewCommand(command, input.cwd || process.cwd(), { env });
  return { review, output: outputFor(review, env) };
}

function decide(input, env = process.env) {
  return evaluate(input, env).output;
}

function outputFor(review, env) {
  if (review.status === "skip") return null;
  // Nothing would change (e.g. `rm -f missing.txt`): leave it to Claude Code.
  if (review.status === "preview" && !review.effects.length && !review.errors.length) return null;
  const strict = env.FILE_REVIEW_STRICT === "1";
  const deny = strict && review.status === "unpreviewable";
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: deny ? "deny" : "ask",
      permissionDecisionReason: deny
        ? `${review.text}\n\nBlocked by FILE_REVIEW_STRICT: rewrite the command using plain rm, cp or mv on paths inside the working folder so it can be previewed.`
        : review.text,
    },
  };
}

function main() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    try {
      const input = JSON.parse(raw || "{}");
      const { review, output } = evaluate(input);
      if (output) process.stdout.write(JSON.stringify(output));
      if (process.env.FILE_REVIEW_LOG && review) {
        fs.appendFileSync(process.env.FILE_REVIEW_LOG, JSON.stringify({
          time: new Date().toISOString(),
          cwd: input.cwd,
          command: input.tool_input.command,
          status: review.status,
          decision: output ? output.hookSpecificOutput.permissionDecision : "none",
          effects: review.effects ? review.effects.length : 0,
          text: review.text || "",
        }) + "\n");
      }
    } catch (err) {
      // A failed preview must not break the Bash tool; the normal prompt still applies.
      process.stderr.write(`file-review: ${err && err.stack || err}\n`);
    }
    process.exit(0);
  });
}

if (require.main === module) main();
module.exports = { decide, evaluate };
