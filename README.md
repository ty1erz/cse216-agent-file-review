# Helping Users Review AI Agent File Operations

CSE 216 project, Fall 2026: Xiaokang Ye, Jixuan Chen, Yirui Miao, Tianyue Zhang, Zifan Yang.

When an AI agent wants to delete, copy or move files, a plain "Approve?" prompt
rarely shows *which* files change. We compare that prompt with a structured
preview of every affected file.

## What's here

| Path | What it is |
|---|---|
| `prototype/` | Web prototype: a demo of both screens and the survey. No build step. |
| `research/command_selection.md` | Why we chose `rm`, `cp` and `mv`, with data |
| `research/scripts/analyze_nl2bash.py` | Counts commands in the NL2Bash dataset |
| `research/scripts/count_agent_commands.py` | Counts commands in your own Claude Code and Codex logs |
| `research/agent_counts/` | Each teammate's counts (numbers only, no command text) |

## Run the prototype

```bash
python3 -m http.server 8216 --directory prototype
```

Then open http://localhost:8216. Three modes:

- `#try`: the interactive prototype. Type a request in plain English. A model
  sees the mock file tree and proposes the shell commands an agent would run.
  The page sorts them into previewable file changes (`rm`, `cp`, `mv`, `mkdir`,
  with `-r`/`-f`/`-p`, wildcards and quoted names), file changes it can't
  preview (e.g. `chmod`, `sed -i`, `find -delete`, `> file`, `git clean`;
  these block Approve), and read-only commands. Approve applies the change to
  the mock files, and Undo reverts it. You can edit the agent's commands, or
  type your own when the model isn't connected.
- `#demo`: every survey scenario, with an answer key.
- `#survey`: the study.

The interactive mode lives in `prototype/playground.js`.

### How the survey works

- Everyone sees the same 8 scenarios (3 rm, 2 cp, 3 mv), half on the plain
  prompt and half on the file preview.
- Scenarios are split into sets X and Y, each with 2 commands that match the
  request and 2 that don't. A participant is randomly put in one of 4 groups
  (which set goes on which screen × which screen comes first), and scenarios
  are shuffled within each part.
- Each part starts with an unscored practice round.
- We record each decision (approve / reject / request change), whether it was
  correct, response time, a 1–5 confidence rating and an optional comment.
  After each part: 4 Likert items about that screen. At the end: which screen
  they prefer and why.
- No names or emails are collected.

Scenarios live in `prototype/scenarios.js`; the preview logic is in
`prototype/engine.js`.

### Collecting responses

By default, participants download a JSON file at the end. To collect into a
Google Sheet instead:

1. Create a Sheet, then open Extensions → Apps Script and replace the code with
   [`survey/collect_responses.gs`](survey/collect_responses.gs).
2. Deploy → New deployment → Web app, execute as yourself, access "Anyone".
3. Paste the web app URL into `submitUrl` in `prototype/config.js`.

Each response adds a row to the `responses` tab (background, ratings,
preference) and one row per scenario to the `trials` tab (decision, correct,
time, confidence), ready for a pivot table.

Before surveying people outside the team, check with the professor whether
this needs IRB review.

### Connecting the model (`agent-proxy/`)

The page can't hold an API key, so model calls go through a small Apps Script
web app in `agent-proxy/`. Its URL is `agentUrl` in `prototype/config.js`. To
set it up, open the script and go to Project Settings → Script properties:

| Property | Value |
|---|---|
| `LLM_API_KEY` | A Claude API key, or a UCSD TritonAI key |
| `LLM_PROVIDER` | `anthropic` (default) or `openai` for TritonAI |
| `LLM_MODEL` | default `claude-opus-5-5`; for TritonAI e.g. `api-glm-5.3` |
| `LLM_BASE_URL` | TritonAI only: `https://tritonai-api.ucsd.edu/v1` |
| `DAILY_LIMIT` | optional, model calls per day (default 300) |

Then pick `authorize` in the editor's function menu, click Run once, and
approve. The key never leaves Script Properties.

### Publish online

`.github/workflows/pages.yml` publishes `prototype/` to GitHub Pages on every
push to `main`. Turn it on once under the repo's Settings → Pages → Source:
GitHub Actions.

## Add your agent counts

```bash
python3 -I research/scripts/count_agent_commands.py research/agent_counts/<your-name>.json
```

This reads `~/.claude/projects` and `~/.codex`. It saves counts only, never
commands or file names. Commit the JSON.

## Reproduce the NL2Bash numbers

```bash
mkdir -p research/data/nl2bash
curl -sSL -o research/data/nl2bash/all.cm https://raw.githubusercontent.com/TellinaTool/nl2bash/master/data/bash/all.cm
python3 -I research/scripts/analyze_nl2bash.py research/data/nl2bash/all.cm research/nl2bash_counts.json
```

The dataset itself isn't committed (`research/data/` is ignored).
