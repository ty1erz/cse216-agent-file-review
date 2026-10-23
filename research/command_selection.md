# Why rm, cp and mv

We limit the prototype to three commands: `rm` (delete), `cp` (copy) and `mv`
(move/rename). This note gives the evidence for that choice.

## Data source

**NL2Bash** (Lin et al., LREC 2018): 12,607 one-line Bash commands paired with
plain-English descriptions, collected from Q&A sites and tutorials. Each command
is a real answer to a real person's request, which is close to what our users do:
describe a goal in words and let someone else (here, an agent) write the command.

Method (`scripts/analyze_nl2bash.py`): we split each command into its pipeline
parts and count a utility when it runs as a command, including inside
`find -exec` and `xargs`. Each utility counts once per command line.

## Results

Commands that change the filesystem, grouped by what they do:

| Operation | Utilities | Commands | % of all 12,607 |
|---|---|---:|---:|
| **Delete** | rm, rmdir, unlink, shred, `find -delete` | **795** | **6.3%** |
| Permissions | chmod, chown, chgrp | 573 | 4.5% |
| Archive / compress | tar, zip, gzip, split, … | 420 | 3.3% |
| Create | mkdir, touch, ln | 318 | 2.5% |
| **Copy** | cp, rsync | **294** | **2.3%** |
| **Move / rename** | mv, rename | **264** | **2.1%** |

- 2,647 commands (21%) change the filesystem in some way.
- **Delete, copy and move together make up 1,349 of those, or 51%.**
- `rm` is the single most common file-changing utility (619 commands), ahead of
  `chmod` (350), `mv` (201) and `cp` (162).

Evidence that scope is hard to see in these commands:

- **296 of 619 `rm` commands use a wildcard (`*`)**, so the command text doesn't
  say which files will go.
- **131 use `rm -r`**, which removes whole folder trees.
- **819 of the 1,349 delete/copy/move commands are combined with `find`**, where
  the affected set depends on a search the user never sees.

## Why not the others

- **Permissions (chmod/chown)** are common, but they don't change *which* files
  exist or *where* they are. Previewing them needs a different design (old vs.
  new mode), so we leave them for future work.
- **Archive and create** commands mostly add files and rarely destroy
  anything, so the cost of a scope mistake is low.

## Second source: our own agent logs

NL2Bash shows what people ask for. To see what agents actually run, we count
the tool calls in our own local logs from Claude Code and Codex. We haven't
picked which agent a plugin would target, so the script reads both
(`scripts/count_agent_commands.py`). It saves counts only, never command text
or file names, into `research/agent_counts/<name>.json`.

First data point (one teammate, Oct 23 2026):

| | Claude Code | Codex |
|---|---:|---:|
| Session files | 2 | 22 |
| Shell calls | 19 | 991 |
| `rm` / `cp` / `mv` in shell | 2 / 2 / 2 | 7 / 9 / 1 |
| Other file-changing shell commands | mkdir 3 | mkdir 16, unzip 10, zip 3, tar 1 |
| Edits through the agent's own tool | Write 11, Edit 4 | apply_patch: 140 updates, 34 new files, 6 deletions |

Early observations (too little data to generalize):

- Among file-changing shell commands that can destroy data, `rm`, `cp` and
  `mv` are the only ones that show up. `mkdir` and `unzip` are common but only
  add files.
- Most file changes go through the agent's own edit tool, not the shell. Codex
  also deletes files through `apply_patch` (6 times). A plugin would need to
  preview those too, not just shell commands.
- `git` is the second most common Codex command (142 calls). Destructive git
  commands (`git rm`, `git clean`, `git reset --hard`) are a natural next step
  after rm/cp/mv.

**To do before the final report:** every teammate runs the script below and
commits their JSON so we can pool the counts.

```bash
python3 -I research/scripts/count_agent_commands.py research/agent_counts/<your-name>.json
```

## Limitations

- NL2Bash is written by people, not agents, and it is heavy on `find` (62% of
  commands) because of how it was collected. Its percentages show what file
  tasks people ask for, not exactly what agents run.
- The agent logs come from our own coding work (course projects, LaTeX), so
  they reflect our habits, not agents in general.

## Reproduce

```bash
mkdir -p research/data/nl2bash
curl -sSL -o research/data/nl2bash/all.cm https://raw.githubusercontent.com/TellinaTool/nl2bash/master/data/bash/all.cm
python3 -I research/scripts/analyze_nl2bash.py research/data/nl2bash/all.cm research/nl2bash_counts.json
```

## Reference

X. V. Lin, C. Wang, L. Zettlemoyer, M. D. Ernst. "NL2Bash: A Corpus and Semantic
Parser for Natural Language Interface to the Linux Operating System." LREC 2018.
