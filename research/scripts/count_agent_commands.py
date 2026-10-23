"""Count which utilities coding agents ran, from local Claude Code and Codex logs.

Usage: python3 -I count_agent_commands.py [out.json] [--claude DIR] [--codex DIR]

Defaults read ~/.claude/projects and ~/.codex (sessions and archived_sessions).
Shell commands are counted the same way analyze_nl2bash.py does. File changes
made through each agent's own edit tools (Claude Code's Write/Edit, Codex's
apply_patch) are counted separately, since they never go through the shell.

The output holds only counts, never command text or file names, so teammates
can share it without exposing their projects.
"""
import argparse
import collections
import glob
import json
import os
import re
import shlex
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyze_nl2bash import FILE_MODIFYING, utilities  # noqa: E402

SHELLS = {"bash", "sh", "zsh", "/bin/bash", "/bin/sh", "/bin/zsh"}
CLAUDE_EDIT_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}
PATCH_OPS = {
    "add": re.compile(r"^\*\*\* Add File:", re.M),
    "update": re.compile(r"^\*\*\* Update File:", re.M),
    "delete": re.compile(r"^\*\*\* Delete File:", re.M),
    "move": re.compile(r"^\*\*\* Move to:", re.M),
}


def unwrap(cmd):
    """Turn ["bash", "-lc", "rm x"] or 'bash -lc "rm x"' into the inner script."""
    if isinstance(cmd, list):
        if len(cmd) >= 3 and cmd[0] in SHELLS and cmd[1] in {"-c", "-lc", "-ic"}:
            return cmd[-1]
        return " ".join(shlex.quote(c) for c in cmd)
    if isinstance(cmd, str) and re.match(r"^\s*(/bin/)?(ba|z)?sh\s+-l?c\s", cmd):
        try:
            parts = shlex.split(cmd)
            return parts[-1]
        except ValueError:
            pass
    return cmd


def load_json(text):
    try:
        return json.loads(text) if isinstance(text, str) else text
    except json.JSONDecodeError:
        return None


def read_jsonl(path):
    for line in open(path, encoding="utf-8", errors="replace"):
        entry = load_json(line)
        if isinstance(entry, dict):
            yield entry


def claude_events(root):
    """Yield ("shell", script) or ("edit", tool) from Claude Code logs."""
    for path in glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True):
        for entry in read_jsonl(path):
            content = (entry.get("message") or {}).get("content")
            if not isinstance(content, list):
                continue
            for block in content:
                if not isinstance(block, dict) or block.get("type") != "tool_use":
                    continue
                name, args = block.get("name"), block.get("input") or {}
                if name == "Bash" and args.get("command"):
                    yield "shell", args["command"]
                elif name in CLAUDE_EDIT_TOOLS:
                    yield "edit", name


def codex_events(root):
    """Yield ("shell", script) or ("patch", text) from Codex CLI logs.

    Handles the formats Codex has used: function_call "exec_command" {cmd},
    function_call "shell" {command: [...]}, and local_shell_call {action.command}.
    """
    paths = [p for d in ("sessions", "archived_sessions")
             for p in glob.glob(os.path.join(root, d, "**", "*.jsonl"), recursive=True)]
    for path in paths:
        for entry in read_jsonl(path):
            item = entry.get("payload") if isinstance(entry.get("payload"), dict) else entry
            kind, name = item.get("type"), item.get("name")
            if kind == "function_call":
                args = load_json(item.get("arguments")) or {}
                cmd = args.get("cmd") or args.get("command")
                if name in {"exec_command", "shell", "container.exec"} and cmd:
                    yield "shell", unwrap(cmd)
                elif name == "apply_patch":
                    yield "patch", args.get("input") or ""
            elif kind == "local_shell_call":
                cmd = (item.get("action") or {}).get("command")
                if cmd:
                    yield "shell", unwrap(cmd)
            elif kind == "custom_tool_call" and name == "apply_patch":
                yield "patch", item.get("input") or ""


SHELL_KEYWORDS = {"for", "while", "until", "if", "then", "else", "elif", "fi", "do",
                  "done", "case", "esac", "in", "true", "false", "!", "[", "[[", "]]"}
HEREDOC = re.compile(r"<<-?\s*['\"]?(\w+)['\"]?")
PROGRAM_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_+-]{0,19}$")


def script_lines(script):
    """Lines of a shell script, minus heredoc bodies (inline Python and such)."""
    out, end = [], None
    for line in script.splitlines():
        if end is not None:
            if line.strip() == end:
                end = None
            continue
        if line.strip():
            out.append(line)
        m = HEREDOC.search(line)
        if m:
            end = m.group(1)
    return out


def tally(events):
    per_util = collections.Counter()
    edits = collections.Counter()
    shell_calls = 0
    deletes_via_find = 0
    for kind, value in events:
        if kind == "shell":
            shell_calls += 1
            lines = script_lines(value)
            used = set().union(*(utilities(l) for l in lines)) - SHELL_KEYWORDS if lines else set()
            per_util.update(used)
            if "find" in used and re.search(r"\s-delete(\s|$)", value):
                deletes_via_find += 1
        elif kind == "edit":
            edits[value] += 1
        elif kind == "patch":
            for op, rx in PATCH_OPS.items():
                n = len(rx.findall(value))
                if n:
                    edits["apply_patch:" + op] += n
    return {
        "shell_calls": shell_calls,
        "file_modifying_utilities": sorted(
            ((u, c) for u, c in per_util.items() if u in FILE_MODIFYING), key=lambda kv: -kv[1]),
        "find_delete": deletes_via_find,
        "edit_tool_calls": dict(edits.most_common()),
        # only names that look like programs, so no code fragments leak out
        "top_utilities": [(u, c) for u, c in per_util.most_common()
                          if PROGRAM_NAME.match(u)][:25],
    }


def report(label, sessions, r):
    print(f"\n== {label}: {sessions} session files, {r['shell_calls']} shell calls")
    if not r["shell_calls"]:
        return
    for u, c in r["file_modifying_utilities"]:
        print(f"  {u:<10} {c:>5}  {100 * c / r['shell_calls']:5.1f}% of shell calls")
    if r["find_delete"]:
        print(f"  find -delete {r['find_delete']:>3}")
    if r["edit_tool_calls"]:
        print("  edit tools:", ", ".join(f"{k} {v}" for k, v in r["edit_tool_calls"].items()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out", nargs="?", default="agent_counts.json")
    ap.add_argument("--claude", default="~/.claude/projects")
    ap.add_argument("--codex", default="~/.codex")
    a = ap.parse_args()
    claude_root, codex_root = os.path.expanduser(a.claude), os.path.expanduser(a.codex)

    n_claude = len(glob.glob(os.path.join(claude_root, "**", "*.jsonl"), recursive=True))
    n_codex = sum(len(glob.glob(os.path.join(codex_root, d, "**", "*.jsonl"), recursive=True))
                  for d in ("sessions", "archived_sessions"))
    result = {
        "claude_code": {"sessions": n_claude, **tally(claude_events(claude_root))},
        "codex": {"sessions": n_codex, **tally(codex_events(codex_root))},
    }
    json.dump(result, open(a.out, "w"), indent=2)
    report("Claude Code", n_claude, result["claude_code"])
    report("Codex", n_codex, result["codex"])
    print(f"\nwrote {a.out}")


if __name__ == "__main__":
    main()
