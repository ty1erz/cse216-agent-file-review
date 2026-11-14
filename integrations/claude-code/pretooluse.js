#!/usr/bin/env node
// Claude Code PreToolUse hook for the Bash tool. When a command runs rm, cp or
// mv (configurable with FILE_REVIEW_COMMANDS), it replaces the plain approval
// prompt with one that lists every file the command would change. Commands we
// don't review produce no output, so Claude Code's normal permissions apply.

"use strict";

const { reviewCommand } = require("../core/review.js");

function decide(input, env = process.env) {
  if (!input || input.tool_name !== "Bash") return null;
  const command = input.tool_input && input.tool_input.command;
  const review = reviewCommand(command, input.cwd || process.cwd(), { env });
  if (review.status === "skip") return null;
  // An empty preview (e.g. `rm -f missing.txt`) changes nothing; let it through
  // to Claude Code's own permission rules instead of adding a prompt.
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
      const out = decide(JSON.parse(raw || "{}"));
      if (out) process.stdout.write(JSON.stringify(out));
    } catch (err) {
      // Never break the Bash tool because the preview failed; fall back to the
      // normal prompt and leave a trace for `claude --debug`.
      process.stderr.write(`file-review: ${err && err.stack || err}\n`);
    }
    process.exit(0);
  });
}

if (require.main === module) main();
module.exports = { decide };
