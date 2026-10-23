"""Count which utilities appear in NL2Bash commands (Lin et al., LREC 2018).

Usage: python3 -I analyze_nl2bash.py <path/to/all.cm> <out.json>

A utility is counted when it appears in "command position": the first word of
the line, the first word after | ; && || ( $( or `, the argument of xargs, or the
argument of find -exec/-execdir/-ok. Each utility is counted at most once per
command line, so the numbers mean "share of commands that use X".
"""
import collections
import json
import re
import shlex
import sys

SEPARATORS = {"|", ";", "&&", "||", "&", "(", ")", "$(", "`", "{", "}", "|&"}
PREFIXES = {"sudo", "time", "nohup", "nice", "env", "command", "exec", "builtin"}
XARGS_OPTS_WITH_ARG = {"-I", "-i", "-n", "-P", "-d", "-L", "-l", "-s", "-E", "-a", "-u"}

# Utilities that create, change, move or delete files.
FILE_MODIFYING = {
    "rm", "rmdir", "unlink", "shred", "cp", "mv", "rename", "ln", "mkdir",
    "touch", "chmod", "chown", "chgrp", "rsync", "tar", "zip", "unzip", "gzip",
    "gunzip", "bzip2", "dd", "truncate", "split", "install",
}


def tokenize(line):
    try:
        lex = shlex.shlex(line, posix=True, punctuation_chars="|;&()`")
        lex.whitespace_split = True
        return list(lex)
    except ValueError:
        return re.findall(r"\|\||&&|[|;&()`]|[^\s|;&()`]+", line)


def utilities(line):
    tokens = tokenize(line.replace("$(", " ( "))
    found = set()
    expect_cmd = True
    skip_next = False  # option argument of xargs, e.g. the {} in -I {}
    for tok in tokens:
        if tok in SEPARATORS or set(tok) <= set("|;&()`"):
            expect_cmd, skip_next = True, False
            continue
        if skip_next:
            skip_next = False
            continue
        if expect_cmd:
            if tok.startswith("-"):  # xargs/sudo options before the command
                skip_next = tok in XARGS_OPTS_WITH_ARG
                continue
            if "=" in tok:  # VAR=value prefix
                continue
            name = tok.rsplit("/", 1)[-1]
            if name in PREFIXES:
                continue
            found.add(name)
            # xargs runs the next non-option word as a command
            expect_cmd = name == "xargs"
        elif tok in {"-exec", "-execdir", "-ok", "-okdir"}:
            expect_cmd = True
    return found


def main(src, out):
    lines = [l.strip() for l in open(src, encoding="utf-8") if l.strip()]
    per_util = collections.Counter()
    find_delete = 0
    sed_inplace = 0
    for line in lines:
        utils = utilities(line)
        per_util.update(utils)
        if "find" in utils and re.search(r"(^|\s)-delete(\s|$)", line):
            find_delete += 1
        if "sed" in utils and re.search(r"\ssed\s+(-\w*\s+)*-i", " " + line):
            sed_inplace += 1

    total = len(lines)
    modifying = {u: c for u, c in per_util.items() if u in FILE_MODIFYING}
    any_modifying = sum(
        1 for line in lines
        if utilities(line) & FILE_MODIFYING or re.search(r"\s-delete(\s|$)", line)
    )
    # rm via find -delete is still a deletion
    deletion = sum(
        1 for line in lines
        if {"rm", "rmdir", "unlink", "shred"} & utilities(line)
        or re.search(r"\s-delete(\s|$)", line)
    )
    result = {
        "source": "NL2Bash all.cm (github.com/TellinaTool/nl2bash)",
        "total_commands": total,
        "top_utilities": per_util.most_common(30),
        "file_modifying_utilities": sorted(modifying.items(), key=lambda kv: -kv[1]),
        "commands_with_any_file_modification": any_modifying,
        "commands_that_delete": deletion,
        "find_delete": find_delete,
        "sed_in_place": sed_inplace,
    }
    json.dump(result, open(out, "w"), indent=2)

    print(f"total commands: {total}")
    print("\nTop 30 utilities (share of commands):")
    for u, c in per_util.most_common(30):
        print(f"  {u:<10} {c:>5}  {100 * c / total:5.1f}%")
    print("\nFile-modifying utilities:")
    for u, c in result["file_modifying_utilities"]:
        print(f"  {u:<10} {c:>5}  {100 * c / total:5.1f}%")
    print(f"\nany file modification: {any_modifying} ({100 * any_modifying / total:.1f}%)")
    print(f"deletes something (rm/rmdir/unlink/shred/-delete): {deletion}")
    print(f"find -delete: {find_delete}   sed -i: {sed_inplace}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
