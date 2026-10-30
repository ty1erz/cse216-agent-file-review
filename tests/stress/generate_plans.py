"""Ask real models for plans, the same way the agent proxy does, and save them.

Usage (from the repo root, with API_KEY=<TritonAI key> in .env):
    python3 -I tests/stress/generate_plans.py tests/stress/plans.json api-glm-5.3-flash api-muse-glimmer-30b

Uses the proxy's own system prompt (agent-proxy/agent_proxy.gs) and the
prototype's home-folder workspace (tests/stress/workspace.json, from
dump_workspace.js). The key is read from .env and never printed.
"""
import json
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = "https://tritonai-api.ucsd.edu/v1"


def read_key():
    for line in open(".env"):
        m = re.match(r"\s*API_KEY\s*=\s*['\"]?([^'\"\s]+)", line)
        if m:
            return m.group(1)
    raise SystemExit("API_KEY not found in .env")


def system_prompt():
    src = open("agent-proxy/agent_proxy.gs").read()
    block = src[src.index("SYSTEM_PROMPT"):src.index('].join(" ")')]
    text = " ".join(re.findall(r'^\s*"(.*)",?$', block, re.M))
    return text + (' Answer with only a JSON object of the form {"reply": string, '
                   '"commands": [{"command": string, "purpose": string}]} and nothing else.')


def listing(files):
    lines = []
    for f in files:
        p = f["path"]
        lines.append(p if p.endswith("/") else f"{p}  ({f.get('size', 0)} bytes, modified {f.get('mtime', 'unknown')})")
    return "\n".join(lines)


def ask(key, model, system, user):
    body = json.dumps({"model": model, "messages": [
        {"role": "system", "content": system}, {"role": "user", "content": user}]}).encode()
    req = urllib.request.Request(BASE + "/chat/completions", data=body, headers={
        "Authorization": "Bearer " + key, "Content-Type": "application/json"})
    start = time.time()
    try:
        data = json.load(urllib.request.urlopen(req, timeout=120))
        text = data["choices"][0]["message"]["content"] or ""
        plan = json.loads(text[text.index("{"):text.rindex("}") + 1])
        commands = [{"command": str(c.get("command", "")), "purpose": str(c.get("purpose", ""))}
                    for c in plan.get("commands", []) if c.get("command")]
        return {"reply": str(plan.get("reply", "")), "commands": commands, "seconds": round(time.time() - start, 1)}
    except (urllib.error.URLError, ValueError, KeyError, TimeoutError) as e:
        return {"error": f"{type(e).__name__}: {e}"[:300], "seconds": round(time.time() - start, 1)}


def main():
    out_path, models = sys.argv[1], sys.argv[2:]
    key = read_key()
    ws = json.load(open("tests/stress/workspace.json"))
    system = system_prompt()
    prompts = [l.strip() for l in open("tests/stress/prompts.txt") if l.strip() and not l.startswith("#")]
    user = lambda p: f"Today is {ws['today']}.\n\nFiles in the home folder:\n{listing(ws['files'])}\n\nRequest: {p}"

    jobs = [(m, p) for m in models for p in prompts]
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda job: {"model": job[0], "request": job[1], **ask(key, job[0], system, user(job[1]))}, jobs))
    json.dump(results, open(out_path, "w"), indent=1)
    errors = sum(1 for r in results if "error" in r)
    print(f"{len(results)} plans ({errors} errors) -> {out_path}")


if __name__ == "__main__":
    main()
