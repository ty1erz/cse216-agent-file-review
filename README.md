# Helping Users Review AI Agent File Operations

CSE 216 project, Fall 2026: Xiaokang Ye, Jixuan Chen, Yirui Miao, Tianyue Zhang, Zifan Yang.

When an AI agent wants to delete, copy or move files, a plain "Approve?" prompt
rarely shows which files change. We built a preview that lists every affected
file, in two forms:

- a **Claude Code plugin** that adds the preview to Claude Code's own approval
  prompt, on your real files, and
- a **web prototype** that shows the plain prompt and the preview side by side
  on a mock folder.

**Live demo:** [web prototype](https://ty1erz.github.io/cse216-agent-file-review/#try) ·
[all scenarios with answer key](https://ty1erz.github.io/cse216-agent-file-review/#demo)

## Repository

| Path | Contents |
|---|---|
| `integrations/` | The plugin. `core/` previews a command (dry run or simulation) for any agent; `claude-code/` is the Claude Code hook and the demo folder builder. |
| `.claude-plugin/`, `hooks/` | Plugin manifest, marketplace entry and hook registration. |
| `prototype/` | Web prototype; `engine.js` is the simulator shared with the plugin. No build step. |
| `agent-proxy/`, `survey/` | Apps Script back ends: the model proxy for `#try` and the survey collector. |
| `tests/` | Node tests; `tests/stress/` holds real agent runs and the scripts that produce them. |
| `docs/` | Study design and third-party notices. |
| `research/` | Why we started with `rm`, `cp` and `mv`, with command counts. |

## Claude Code plugin

Before Claude runs a Bash command that uses `rm`, `cp`, `mv`, `mkdir`, `rmdir`,
`tar`, `gzip`, `gunzip`, `zip`, `unzip` or `rsync`, the approval prompt lists
every file it would delete, overwrite, move, compress or create:

```text
Bash command
  cp camera/*.jpg photos/
Hook PreToolUse:Bash requires confirmation for this command:
File change preview (dry run in a sandboxed copy of /tmp/fr-demo)
OVERWRITE 2 files — old contents are lost
  ! photos/IMG_0001.jpg  (3.4 MB)
  ! photos/IMG_0002.jpg  (3.5 MB)
CREATE 1 file
  + photos/IMG_0003.jpg
Do you want to proceed?
❯ 1. Yes
  2. No
```

You still choose Yes or No; the plugin never changes your files.

### Install

Requires Claude Code and Node.js 20 or later.

For one session, from a checkout:

```bash
claude --plugin-dir /path/to/cse216-agent-file-review
```

For every session:

```bash
claude plugin marketplace add ty1erz/cse216-agent-file-review
```

```bash
claude plugin install file-review@cse216-agent-file-review
```

Turn it off with `claude plugin disable file-review`.

### Try it

Build a throwaway copy of the study's mock home folder (sparse files, so it
takes no real space), then start Claude Code in it:

```bash
npm run demo -- /tmp/file-review-demo
```

```bash
cd /tmp/file-review-demo && claude --plugin-dir /path/to/cse216-agent-file-review
```

The script prints requests to try, such as "Copy the new photos from camera
into my photos library", which overwrites two photos.

### How it works

A PreToolUse hook (`integrations/claude-code/pretooluse.js`) sees each Bash
command before it runs. Commands that use none of the reviewed commands pass
through to Claude Code's usual permissions. For the rest:

1. **Dry run** (macOS). The working folder is cloned copy-on-write, which is
   instant and takes no extra space. The command runs on the clone under
   `sandbox-exec`, with the network and every write outside the clone blocked.
   The clone is compared before and after, and the differences are the
   preview. Because the real shell runs the command, quoting, variables,
   loops, pipes and file contents all behave exactly as they will for real.
2. **Simulation** (fallback). If the dry run is not possible (not macOS, a
   folder over 20,000 entries, a write outside the folder, the network, or
   more than 4 seconds), `prototype/engine.js` simulates the command on a list
   of file names, sizes and dates. The prompt says why it fell back.
3. **Always ask.** A reviewed command always gets a prompt. If part of it
   cannot be simulated, the prompt says so and lists every remaining step
   under NOT PREVIEWED, with `!` on steps that change files.

`integrations/core/` has nothing specific to Claude Code; another agent needs
only an adapter that passes the command and folder to `reviewCommand()`.

### Settings

Environment variables, set before starting `claude`:

| Variable | Effect |
|---|---|
| `FILE_REVIEW_MODE=simulate` | Skip the dry run and always simulate. |
| `FILE_REVIEW_COMMANDS` | Commands that trigger a review, comma-separated. Default: all listed above. |
| `FILE_REVIEW_STRICT=1` | Refuse commands that cannot be previewed instead of asking, so Claude rewrites them. |
| `FILE_REVIEW_LOG=<file.jsonl>` | Log every Bash command and the plugin's decision. |

### Limitations

- The dry run needs macOS. Elsewhere the simulator is used; it previews most
  agent commands but not loops that build names with other commands,
  `cd subdir` followed by `../`, `cp -R dir/.`, `tar -x`, or `zip`.
- Commands that need the network or write outside the working folder cannot
  be dry-run.
- `git mv` and the agent's own file-edit tools are not reviewed.

## Web prototype

```bash
python3 -m http.server 8216 --directory prototype
```

Open http://localhost:8216:

- `#try`: type a request; a model sees the mock folder and proposes shell
  commands, which are previewed and applied to the mock files on Approve.
  Without a model connected, type commands yourself.
- `#demo`: every scenario, with the plain prompt or the preview, in OpenHands,
  Cline or Codex CLI style shells, plus an answer key.
- `#survey`: a within-subjects study of 8 scenarios (3 `rm`, 2 `cp`, 3 `mv`),
  half on each screen, counterbalanced. Design and analysis plan:
  [`docs/experiment-design.md`](docs/experiment-design.md).

`.github/workflows/pages.yml` publishes `prototype/` to GitHub Pages on every
push to `main` that changes it.

### Back ends

Both are Apps Script web apps; their URLs are in `prototype/config.js`.

- **Model proxy** (`agent-proxy/`), used by `#try`. In Project Settings →
  Script properties set `LLM_API_KEY` (Claude or UCSD TritonAI), and for
  TritonAI also `LLM_PROVIDER=openai` and
  `LLM_BASE_URL=https://tritonai-api.ucsd.edu/v1`. Optional: `LLM_MODEL`,
  `DAILY_LIMIT` (default 300). Run `authorize` once, deploy as a web app and
  set `agentUrl`. The key never reaches the page.
- **Survey collector** (`survey/collect_responses.gs`). Paste it into a
  Sheet's Apps Script, deploy as a web app with access "Anyone", and set
  `submitUrl`. Each response adds a row to `responses` and one row per
  scenario to `trials`; the page reports success only after the collector
  confirms the save.

## Development

```bash
npm test
```

Node.js 20 or later, no packages to install. CI runs the tests on every push
and pull request; dry-run tests run only on macOS.

`main` is protected: push a branch and open a pull request. No approval is
required.

### Real agent runs

`tests/stress/run_claude_code.js` sends each request in a prompts file to
headless Claude Code with the plugin, each in a fresh demo folder, and logs
every Bash command. Headless runs cannot answer the prompt, so the folders
are not changed. It uses your Claude Code login:

```bash
node tests/stress/run_claude_code.js /tmp/fr-runs --jobs 6 --only delete,copy,move,rename,combined,risky
```

```bash
node tests/stress/run_claude_code.js /tmp/fr-edge --jobs 6 --prompts tests/stress/prompts-edge.txt
```

Across both sets (64 requests, 241 commands), the dry run previewed all 65
reviewed commands; the simulator alone previewed 56.

`tests/model-plans.test.js` replays saved TritonAI model plans
(`tests/stress/plans*.json`) through the simulator. To collect a new batch
(needs a TritonAI key in `.env`):

```bash
python3 -I tests/stress/generate_plans.py tests/stress/plans-new.json api-glm-5.3-flash
```

## Research data

Count the commands in your own Claude Code and Codex logs (counts only, never
command text) and commit the JSON:

```bash
python3 -I research/scripts/count_agent_commands.py research/agent_counts/<your-name>.json
```

Reproduce the NL2Bash numbers in `research/command_selection.md`:

```bash
mkdir -p research/data/nl2bash
```

```bash
curl -sSL -o research/data/nl2bash/all.cm https://raw.githubusercontent.com/TellinaTool/nl2bash/master/data/bash/all.cm
```

```bash
python3 -I research/scripts/analyze_nl2bash.py research/data/nl2bash/all.cm research/nl2bash_counts.json
```
