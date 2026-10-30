# Helping Users Review AI Agent File Operations

CSE 216 project, Fall 2026: Xiaokang Ye, Jixuan Chen, Yirui Miao, Tianyue Zhang, Zifan Yang.

When an AI agent wants to delete, copy or move files, a plain "Approve?" prompt
rarely shows *which* files change. We compare that prompt with a structured
preview of every affected file. Both screens are embedded in recognizable
OpenHands, Cline and Codex CLI interaction shells so the prototype can also be
evaluated in the context of current coding-agent interfaces.

**Live:** [interactive prototype](https://ty1erz.github.io/cse216-agent-file-review/#try) ·
[survey](https://ty1erz.github.io/cse216-agent-file-review/#survey) ·
[demo with answer key](https://ty1erz.github.io/cse216-agent-file-review/#demo)

## What's here

| Path | What it is |
|---|---|
| `prototype/` | Web prototype: both confirmation screens in three agent harnesses, the interactive `#try` mode and the survey. No build step. |
| `agent-proxy/` | Apps Script proxy that asks a model (Claude or UCSD TritonAI) for commands; the API key stays in its Script Properties. |
| `survey/` | Apps Script collector that writes survey responses to the team's Google Sheet and confirms each save. |
| `tests/` | Node tests for the engine, classifier, collector and survey submission; `tests/stress/` holds real model plans and the scripts that collect and replay them. |
| `docs/experiment-design.md` | Integrated study design, assignment and analysis plan. |
| `docs/third-party-notices.md` | Upstream interface references, revisions and licenses. |
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
  The page distinguishes supported file changes, an explicit set of read-only
  commands, and commands it cannot preview. Supported changes are `rm`, `cp`,
  `mv`, `mkdir`, `rmdir`, `tar -c` and `gzip` (with common flags such as `-r`,
  `-n`, `-u`, `-a` and `-t DIR`), plus `find` with `-delete` or
  `-exec rm/mv/cp {}` and simple `for f in ...; do ...; done` loops, which are
  previewed as the exact commands they expand to. Read-only pipelines
  (`find ... | sort`), `2>/dev/null` and `||` are understood. Anything else
  blocks Approve. Approve applies the change to the mock files, and Undo
  reverts it. You can edit the agent's commands, or type your own when the
  model isn't connected.
- `#demo`: every survey scenario, with selectors for the confirmation screen
  and agent harness, plus an answer key.
- `#survey`: the study.

The interactive mode lives in `prototype/playground.js`.

### How the survey works

- Everyone sees the same 8 scenarios (3 rm, 2 cp, 3 mv), half on the plain
  prompt and half on the file preview.
- Each participant is assigned one harness for the entire survey: OpenHands,
  Cline or Codex CLI. Assignment is random by default, or can be fixed with the
  links below when the team needs balanced group sizes.
- Scenarios are split into sets X and Y, each with 2 commands that match the
  request and 2 that don't. A participant is randomly put in one of 4 groups
  (which set goes on which screen × which screen comes first), and scenarios
  are shuffled within each part.
- Each part starts with an unscored practice round.
- We record each decision (approve / reject / request change), binary approval
  accuracy, response time, a 1–5 confidence rating and an optional comment.
  Accuracy means approving matching commands and declining mismatching ones;
  reject and request change both count as declining. The action itself is
  retained for separate analysis.
  After each part: 4 Likert items about that screen. At the end: which screen
  they prefer and why.
- No names or emails are collected.

For a small pilot, distribute the fixed links evenly instead of relying on
random assignment:

- `?harness=openhands#survey`
- `?harness=cline#survey`
- `?harness=codex#survey`

For example, with five team reviewers use two OpenHands links, two Cline links
and one Codex link. Treat harness comparisons as exploratory at that sample
size; the main study comparison remains plain prompt versus file preview.

Scenarios live in `prototype/scenarios.js`; the preview logic is in
`prototype/engine.js`.

### Collecting responses

The checked-in configuration submits to the team's Google Sheet collector.
Participants can also download a JSON file. To configure another collector:

1. Create a Sheet, then open Extensions → Apps Script and replace the code with
   [`survey/collect_responses.gs`](survey/collect_responses.gs).
2. Deploy → New deployment → Web app, execute as yourself, access "Anyone".
3. Paste the web app URL into `submitUrl` in `prototype/config.js`.

Each response adds a row to the `responses` tab (background, ratings,
preference) and one row per scenario to the `trials` tab (decision, correct,
time, confidence), ready for a pivot table. Both tabs include the assigned
`harness`. Replace the deployed Apps Script with the current file and create a
new deployment version to enable schema validation, safe text cells, duplicate
protection and storage receipts. After posting, the page reads
`?receipt=<response-id>` and reports success only if the collector confirms
the response and all eight trials. With an older deployment, submission stays
unconfirmed; the participant is asked to download the response. Completed
responses are backed up in this browser until receipt confirmation, and can
be downloaded from the home page after a reload.

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
| `LLM_MODEL` | default `claude-opus-5-5` (Claude) or `api-glm-5.3-flash` (TritonAI) |
| `LLM_BASE_URL` | TritonAI only: `https://tritonai-api.ucsd.edu/v1` |
| `DAILY_LIMIT` | optional, model calls per day (default 300) |

Then pick `authorize` in the editor's function menu, click Run once, and
approve. Deploy the web app with access for the intended participants and set
`agentUrl` to that deployment's `/exec` URL. Opening it should return
`{"ok":true,"configured":true}`. The key never appears in the front end.

## Verify changes

Run `npm test` with Node.js 20 or later; no packages need installing. Tests
cover the command preview engine, command classification, async request state,
survey collector and storage confirmation. CI runs them on every push and PR.
For a manual check, open `#try`, `#demo`, and each fixed harness survey link.
The interactive prototype is a separate demonstration; only `#survey` records
study decisions. The study uses its displayed reference date for every file.

`tests/model-plans.test.js` replays real model plans saved in
`tests/stress/plans*.json` and fails if any of them stops previewing. To
collect a new batch and see what blocks (needs a TritonAI key in `.env`):

```bash
python3 -I tests/stress/generate_plans.py tests/stress/plans-new.json api-glm-5.3-flash
node tests/stress/replay.js tests/stress/plans-new.json --verbose
```

Requests live in `tests/stress/prompts.txt`; the workspace is the home folder
from `prototype/scenarios.js` (`node tests/stress/dump_workspace.js`).

### Publish online

`.github/workflows/pages.yml` publishes `prototype/` to GitHub Pages on every
push to `main` that changes it (Settings → Pages → Source: GitHub Actions is
already enabled). Browsers may cache the old files for up to 10 minutes.

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
