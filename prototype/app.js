// UI for the demo and the survey. Two review screens for the same proposed
// command:
//   baseline   — the agent's one-line description, like a normal confirm prompt
//   structured — a preview of every file the command touches, computed by Engine

(function () {
  "use strict";

  const app = document.getElementById("app");

  // ---------- small helpers ----------

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "class") el.className = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function fmtSize(bytes) {
    if (bytes == null) return "";
    if (bytes < 1000) return bytes + " B";
    if (bytes < 1e6) return Math.round(bytes / 1000) + " KB";
    if (bytes < 1e9) return (bytes / 1e6).toFixed(1) + " MB";
    return (bytes / 1e9).toFixed(1) + " GB";
  }

  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso + "T12:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  function shuffle(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function scopeLabel(scope) {
    return scope.map((s) => s + "/").join(" or ");
  }

  // ---------- review screens ----------

  function requestCard(sc) {
    return h("section", { class: "request" },
      h("div", { class: "eyebrow" }, "You asked the assistant"),
      h("p", { class: "request-text" }, "“" + sc.request + "”"),
      h("div", { class: "today" }, "Today is " + window.TODAY));
  }

  function baselineView(sc) {
    return h("section", { class: "review baseline", "aria-label": "Confirmation prompt" },
      h("div", { class: "prompt-head" }, h("span", { class: "dot" }), "The assistant wants to run a command"),
      h("pre", { class: "cmd" }, sc.command),
      h("p", { class: "agent-says" }, sc.agentSays),
      h("p", { class: "prompt-q" }, "Do you want to proceed?"));
  }

  function structuredView(sc, precomputed) {
    const result = precomputed || Engine.simulate(sc.files, sc.command);
    const sum = Engine.summarize(result);
    const outside = result.effects.filter((e) => Engine.outsideScope(e, sc.scope));

    const chips = [];
    if (sum.deleted) chips.push(chip("del", `Deletes ${sum.deleted} file${sum.deleted > 1 ? "s" : ""}` + (sum.bytesLost ? ` · ${fmtSize(sum.bytesLost)}` : "")));
    if (sum.moved) chips.push(chip("mov", `Moves ${sum.moved} file${sum.moved > 1 ? "s" : ""}`));
    if (sum.created) chips.push(chip("new", `Creates ${sum.created} file${sum.created > 1 ? "s" : ""}`));
    if (sum.overwritten) chips.push(chip("ovr", `Overwrites ${sum.overwritten} existing file${sum.overwritten > 1 ? "s" : ""}`));
    chips.push(sum.irreversible ? chip("warn", "Cannot be undone") : chip("ok", "Nothing is lost"));
    if (!sc.scope.length) chips.push(chip("neutral", "No folder named in the request"));
    else if (outside.length) chips.push(chip("warn", `${outside.length} change${outside.length > 1 ? "s" : ""} outside ${scopeLabel(sc.scope)}`));
    else chips.push(chip("ok", `All changes inside ${scopeLabel(sc.scope)}`));

    return h("section", { class: "review structured", "aria-label": "File preview" },
      h("div", { class: "prompt-head" }, h("span", { class: "dot" }), "The assistant wants to run a command"),
      h("pre", { class: "cmd" }, sc.command),
      h("p", { class: "agent-says" }, sc.agentSays),
      h("div", { class: "chips" }, chips),
      result.errors.length ? h("ul", { class: "errors" }, result.errors.map((e) => h("li", {}, e))) : null,
      h("div", { class: "preview-grid" },
        h("div", { class: "panel" },
          h("div", { class: "panel-title" }, "What happens to your files"),
          treeView(result, sc),
          legend()),
        detailsView(result, sc)));
  }

  function chip(kind, text) {
    return h("span", { class: "chip chip-" + kind }, text);
  }

  function legend() {
    return h("div", { class: "legend" },
      h("span", { class: "lg lg-del" }, "deleted"),
      h("span", { class: "lg lg-ovr" }, "overwritten"),
      h("span", { class: "lg lg-mov" }, "moved"),
      h("span", { class: "lg lg-new" }, "new"),
      h("span", { class: "lg lg-out" }, "⚠ outside your request"));
  }

  // One row per file or folder in the union of the before and after trees.
  function treeView(result, sc) {
    const { before, after, effects } = result;
    const byTarget = new Map();
    const byFrom = new Map();
    for (const e of effects) {
      if (e.type === "move") byFrom.set(e.from, e);
      byTarget.set(e.path, e);
    }

    function fileStatus(p) {
      const t = byTarget.get(p);
      if (t && t.type === "delete") return { cls: "del", label: "deleted", effect: t };
      if (t && t.before) return { cls: "ovr", label: t.type === "move" ? `replaced by ${t.from}` : `replaced by copy of ${t.from}`, effect: t };
      if (t && t.type === "move") return { cls: "mov", label: "moved here from " + t.from, effect: t };
      if (t) return { cls: "new", label: "new copy of " + t.from, effect: t };
      const f = byFrom.get(p);
      if (f) return { cls: "mov", label: "moved to " + f.path, effect: f, away: true };
      return { cls: "same", label: "" };
    }

    const allDirs = new Set([...before.dirs, ...after.dirs]);
    const allFiles = new Set([...before.files.keys(), ...after.files.keys()]);
    const childrenOf = (dir) => {
      const prefix = dir ? dir + "/" : "";
      const kids = new Set();
      for (const p of [...allDirs, ...allFiles]) {
        if (p && p !== dir && p.startsWith(prefix)) kids.add(prefix + p.slice(prefix.length).split("/")[0]);
      }
      return [...kids].sort((a, b) => (allDirs.has(b) - allDirs.has(a)) || a.localeCompare(b));
    };
    const changedUnder = (dir) => [...allFiles].some((p) => p.startsWith(dir + "/") && fileStatus(p).cls !== "same");

    const rows = [];
    function walk(dir, depth) {
      for (const p of childrenOf(dir)) {
        const name = Engine.baseName(p);
        if (allDirs.has(p)) {
          const gone = before.isDir(p) && !after.isDir(p);
          const isNew = !before.isDir(p) && after.isDir(p);
          const changed = changedUnder(p);
          const count = [...allFiles].filter((f) => f.startsWith(p + "/")).length;
          rows.push(h("div", { class: "row dir " + (gone ? "st-del" : isNew ? "st-new" : changed ? "" : "st-same"), style: `--depth:${depth}` },
            h("span", { class: "icon", "aria-hidden": "true" }, "▸"),
            h("span", { class: "name" }, name + "/"),
            h("span", { class: "meta" }, gone ? "folder removed" : isNew ? "new folder" : changed ? "" : count ? `${count} file${count > 1 ? "s" : ""}, no changes` : "empty")));
          if (changed || gone || isNew) walk(p, depth + 1);
        } else {
          const st = fileStatus(p);
          const meta = (st.away || st.cls === "del" || st.cls === "same") ? before.files.get(p) : after.files.get(p);
          const out = st.effect && Engine.outsideScope(st.effect, sc.scope);
          rows.push(h("div", { class: `row file st-${st.cls}` + (out ? " out" : ""), style: `--depth:${depth}` },
            h("span", { class: "icon", "aria-hidden": "true" }, "·"),
            h("span", { class: "name" }, name),
            h("span", { class: "meta" }, [meta && meta.note, meta && fmtDate(meta.mtime), meta && fmtSize(meta.size)].filter(Boolean).join(" · ")),
            st.label ? h("span", { class: "badge" }, st.label) : null,
            out ? h("span", { class: "badge badge-out", title: "Outside " + scopeLabel(sc.scope) }, "⚠ outside request") : null));
        }
      }
    }
    walk("", 0);
    return h("div", { class: "tree", role: "list" }, rows);
  }

  function detailsView(result, sc) {
    const replaced = result.effects.filter((e) => e.before && e.type !== "delete");
    const moves = result.effects.filter((e) => e.type === "move");
    const deletes = result.effects.filter((e) => e.type === "delete");
    const parts = [];

    if (replaced.length) {
      parts.push(h("div", { class: "panel" },
        h("div", { class: "panel-title" }, "Files that will be replaced"),
        replaced.map((e) => h("div", { class: "beforeafter" },
          h("div", { class: "ba-name" }, e.path),
          h("div", { class: "ba-row ba-before" }, h("b", {}, "Now "), [e.before.note, fmtDate(e.before.mtime), fmtSize(e.before.size)].filter(Boolean).join(" · ")),
          h("div", { class: "ba-row ba-after" }, h("b", {}, "After "), `${e.from} · ${fmtDate(e.after.mtime)} · ${fmtSize(e.after.size)}`)))));
    }
    if (moves.length) {
      parts.push(h("div", { class: "panel" },
        h("div", { class: "panel-title" }, "Old location → new location"),
        h("table", { class: "moves" },
          h("tbody", {}, moves.map((e) => h("tr", { class: Engine.outsideScope(e, sc.scope) ? "out" : "" },
            h("td", {}, e.from), h("td", { class: "arrow" }, "→"), h("td", {}, e.path)))))));
    }
    if (deletes.length) {
      const folders = [...new Set(deletes.map((e) => Engine.parentOf(e.path) || "(top level)"))];
      parts.push(h("div", { class: "panel" },
        h("div", { class: "panel-title" }, "Deleted, by folder"),
        h("ul", { class: "byfolder" }, folders.map((f) => {
          const n = deletes.filter((e) => (Engine.parentOf(e.path) || "(top level)") === f).length;
          const out = !Engine.outsideScope({ type: "delete", path: f + "/x" }, sc.scope) ? "" : "out";
          return h("li", { class: out }, h("span", {}, f + "/"), h("span", { class: "n" }, `${n} file${n > 1 ? "s" : ""}`));
        }))));
    }
    return h("div", { class: "details" }, parts);
  }

  function reviewView(sc, condition) {
    return condition === "structured" ? structuredView(sc) : baselineView(sc);
  }

  // ---------- home ----------

  function home() {
    app.replaceChildren(
      h("main", { class: "narrow" },
        h("h1", {}, "Reviewing AI agent file operations"),
        h("p", { class: "lede" }, "A CSE 216 prototype. An AI assistant proposes a command that deletes, copies or moves files. You decide whether to let it run. Two ways of showing the command are compared: a plain confirmation prompt and a file-by-file preview."),
        h("div", { class: "cards" },
          h("a", { class: "card", href: "#try" }, h("h2", {}, "Try the prototype"), h("p", {}, "Type any rm, cp or mv command against a mock file system and see what it would do before you approve it.")),
          h("a", { class: "card", href: "#survey" }, h("h2", {}, "Take the survey"), h("p", {}, "About 10 minutes, anonymous. Review 8 commands and tell us what you'd do.")),
          h("a", { class: "card", href: "#demo" }, h("h2", {}, "Explore the demo"), h("p", {}, "Browse every scenario, switch between the two screens, and see the answer key."))),
        h("p", { class: "fine" }, "All files shown are made up. Nothing runs on your computer.")));
  }

  // ---------- demo ----------

  function demo() {
    let current = window.SCENARIOS[0];
    let condition = "structured";
    let showKey = false;

    const list = h("nav", { class: "demo-list", "aria-label": "Scenarios" });
    const stage = h("div", { class: "demo-stage" });

    function render() {
      list.replaceChildren(...window.SCENARIOS.map((sc, i) =>
        h("button", { class: "demo-item" + (sc === current ? " active" : ""), onclick: () => { current = sc; render(); } },
          h("span", { class: "num" }, i + 1),
          h("span", {}, h("code", {}, sc.command.split(" ")[0]), " ", sc.request))));
      stage.replaceChildren(h("div", {},
        h("div", { class: "toolbar" },
          h("div", { class: "seg", role: "group", "aria-label": "Screen" },
            ["baseline", "structured"].map((c) => h("button", { class: c === condition ? "on" : "", "aria-pressed": c === condition ? "true" : "false", onclick: () => { condition = c; render(); } },
              c === "baseline" ? "Plain prompt" : "File preview"))),
          h("label", { class: "toggle" }, h("input", { type: "checkbox", checked: showKey, onchange: (e) => { showKey = e.target.checked; render(); } }), " Show answer key")),
        requestCard(current),
        reviewView(current, condition),
        showKey ? h("div", { class: "key " + (current.matches ? "key-ok" : "key-bad") },
          h("b", {}, current.matches ? "Matches the request. " : "Does not match the request. "), current.issue) : null));
    }

    app.replaceChildren(h("header", { class: "bar" }, h("a", { href: "#" }, "← Home"), h("span", {}, "Demo")), h("main", { class: "demo" }, list, stage));
    render();
  }

  // ---------- survey ----------

  const LIKERT = [
    ["affected", "I could tell which files would be affected."],
    ["confident", "I felt confident in my decisions."],
    ["easy", "This screen was easy to understand."],
    ["toomuch", "This screen showed too much information."],
  ];

  function newSession() {
    const group = ["A1", "A2", "B1", "B2"][Math.floor(Math.random() * 4)];
    // A: set X on the plain prompt, set Y on the preview. B: the reverse.
    // 1: plain prompt block first. 2: preview block first.
    const plainSet = group[0] === "A" ? "X" : "Y";
    const plain = { condition: "baseline", scenarios: shuffle(window.SCENARIOS.filter((s) => s.set === plainSet)) };
    const rich = { condition: "structured", scenarios: shuffle(window.SCENARIOS.filter((s) => s.set !== plainSet)) };
    return {
      id: (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)),
      version: window.SURVEY_CONFIG.version,
      group,
      startedAt: new Date().toISOString(),
      blocks: group[1] === "1" ? [plain, rich] : [rich, plain],
      background: {},
      trials: [],
      ratings: {},
      final: {},
    };
  }

  function survey() {
    const s = newSession();
    const steps = [];
    steps.push(() => consentStep(s, next));
    steps.push(() => backgroundStep(s, next));
    s.blocks.forEach((block, bi) => {
      steps.push(() => blockIntro(block, bi, next));
      steps.push(() => trialStep(s, window.PRACTICE, block.condition, true, next));
      block.scenarios.forEach((sc) => steps.push(() => trialStep(s, sc, block.condition, false, next)));
      steps.push(() => ratingStep(s, block.condition, next));
    });
    steps.push(() => finalStep(s, next));
    steps.push(() => doneStep(s));

    let i = 0;
    const total = steps.length;
    function next() {
      i++;
      show();
    }
    function show() {
      app.replaceChildren(
        h("header", { class: "bar" }, h("span", {}, "Survey"),
          h("div", { class: "progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(total - 1), "aria-valuenow": String(i) },
            h("div", { style: `width:${(100 * i) / (total - 1)}%` }))),
        steps[i]());
      window.scrollTo(0, 0);
    }
    show();
  }

  function consentStep(s, next) {
    const box = h("input", { type: "checkbox", id: "agree" });
    const go = h("button", { class: "primary", disabled: true, onclick: next }, "Start");
    box.addEventListener("change", () => { go.disabled = !box.checked; });
    return h("main", { class: "narrow" },
      h("h1", {}, "Before you start"),
      h("p", {}, "This is a class project for CSE 216 at UC San Diego. You'll see 8 situations where an AI assistant wants to delete, copy or move files, and decide whether to let it. Then you'll answer a few questions about the two screens you used."),
      h("ul", {},
        h("li", {}, "It takes about 10 minutes."),
        h("li", {}, "It's anonymous. We record your choices, how long each one took and your answers. No names or emails."),
        h("li", {}, "All files are made up. Nothing runs on your computer."),
        h("li", {}, "You can stop at any time by closing the page; nothing is sent until the end.")),
      h("label", { class: "check", for: "agree" }, box, " I'm 18 or older and agree to take part."),
      h("div", { class: "actions" }, go));
  }

  function choice(name, options, onPick) {
    return h("div", { class: "choices", role: "radiogroup" }, options.map((o) =>
      h("label", { class: "pill" }, h("input", { type: "radio", name, value: o, onchange: () => onPick(o) }), h("span", {}, o))));
  }

  function backgroundStep(s, next) {
    const go = h("button", { class: "primary", disabled: true, onclick: next }, "Continue");
    const check = () => { go.disabled = !(s.background.terminal && s.background.agents); };
    return h("main", { class: "narrow" },
      h("h1", {}, "About you"),
      h("p", { class: "q" }, "How often do you use a terminal or command line?"),
      choice("terminal", ["Never", "A few times", "Monthly", "Weekly or more"], (v) => { s.background.terminal = v; check(); }),
      h("p", { class: "q" }, "Have you used an AI assistant that runs commands or edits files for you (Claude Code, Cursor, Copilot agent, …)?"),
      choice("agents", ["Never", "Tried it", "Use it regularly"], (v) => { s.background.agents = v; check(); }),
      h("div", { class: "actions" }, go));
  }

  function blockIntro(block, bi, next) {
    const plain = block.condition === "baseline";
    return h("main", { class: "narrow" },
      h("div", { class: "eyebrow" }, `Part ${bi + 1} of 2`),
      h("h1", {}, plain ? "The plain prompt" : "The file preview"),
      h("p", {}, plain
        ? "In this part, the assistant shows you the command it wants to run and a short description of what it thinks the command does."
        : "In this part, the assistant shows you the command plus a preview of every file it would change: what is deleted, moved, copied or replaced."),
      h("p", {}, "For each one, choose:"),
      h("ul", {},
        h("li", {}, h("b", {}, "Approve"), " if the command does what you asked"),
        h("li", {}, h("b", {}, "Reject"), " if it shouldn't run"),
        h("li", {}, h("b", {}, "Request change"), " if the idea is right but the command needs fixing")),
      h("p", {}, "We start with one practice round that isn't scored."),
      h("div", { class: "actions" }, h("button", { class: "primary", onclick: next }, "Begin practice")));
  }

  function trialStep(s, sc, condition, practice, next) {
    const shownAt = performance.now();
    const trial = { scenario: sc.id, condition, practice };
    const followup = h("div", { class: "followup" });
    const buttons = h("div", { class: "decide" },
      [["approve", "Approve"], ["reject", "Reject"], ["change", "Request change"]].map(([v, label]) =>
        h("button", { class: "decision decision-" + v, onclick: () => decide(v) }, label)));

    function decide(v) {
      if (trial.decision == null) trial.ms = Math.round(performance.now() - shownAt);
      trial.decision = v;
      trial.correct = (v === "approve") === sc.matches;
      for (const b of buttons.children) b.classList.toggle("picked", b.classList.contains("decision-" + v));
      renderFollowup();
    }

    function renderFollowup() {
      const go = h("button", { class: "primary", disabled: trial.confidence == null, onclick: () => { if (!practice) s.trials.push(trial); next(); } }, "Next");
      const note = h("textarea", {
        rows: 2,
        placeholder: trial.decision === "change" ? "What should the assistant do instead?" : "Optional: what made you decide?",
        oninput: (e) => { trial.comment = e.target.value; },
      });
      if (trial.comment) note.value = trial.comment;
      followup.replaceChildren(
        h("p", { class: "q" }, "How confident are you?"),
        h("div", { class: "scale" },
          h("span", { class: "end" }, "Not at all"),
          [1, 2, 3, 4, 5].map((n) => h("label", { class: "pill" },
            h("input", { type: "radio", name: "conf", value: n, checked: trial.confidence === n, onchange: () => { trial.confidence = n; go.disabled = false; } }),
            h("span", {}, n))),
          h("span", { class: "end" }, "Very")),
        note,
        h("div", { class: "actions" }, go));
    }

    return h("main", { class: "trial" },
      practice ? h("div", { class: "eyebrow" }, "Practice (not scored)") : null,
      requestCard(sc),
      reviewView(sc, condition),
      buttons,
      followup);
  }

  function ratingStep(s, condition, next) {
    const answers = (s.ratings[condition] = {});
    const go = h("button", { class: "primary", disabled: true, onclick: next }, "Continue");
    const check = () => { go.disabled = LIKERT.some(([k]) => answers[k] == null); };
    return h("main", { class: "narrow" },
      h("h1", {}, condition === "baseline" ? "About the plain prompt" : "About the file preview"),
      h("p", {}, "How much do you agree with each statement about the screen you just used?"),
      LIKERT.map(([k, text]) => h("div", { class: "likert" },
        h("p", { class: "q" }, text),
        h("div", { class: "scale" },
          h("span", { class: "end" }, "Strongly disagree"),
          [1, 2, 3, 4, 5].map((n) => h("label", { class: "pill" },
            h("input", { type: "radio", name: k, value: n, onchange: () => { answers[k] = n; check(); } }),
            h("span", {}, n))),
          h("span", { class: "end" }, "Strongly agree")))),
      h("div", { class: "actions" }, go));
  }

  function finalStep(s, next) {
    const go = h("button", { class: "primary", disabled: true, onclick: next }, "Finish");
    return h("main", { class: "narrow" },
      h("h1", {}, "Last questions"),
      h("p", { class: "q" }, "Which screen would you rather use when an assistant changes your files?"),
      choice("prefer", ["The plain prompt", "The file preview", "No preference"], (v) => { s.final.prefer = v; go.disabled = false; }),
      h("p", { class: "q" }, "Why? (optional)"),
      h("textarea", { rows: 3, oninput: (e) => { s.final.why = e.target.value; } }),
      h("p", { class: "q" }, "Was anything confusing or missing in the file preview? (optional)"),
      h("textarea", { rows: 3, oninput: (e) => { s.final.missing = e.target.value; } }),
      h("div", { class: "actions" }, go));
  }

  function doneStep(s) {
    s.finishedAt = new Date().toISOString();
    const status = h("p", { class: "status" });
    const url = window.SURVEY_CONFIG.submitUrl;
    if (url) {
      status.textContent = "Sending your responses…";
      fetch(url, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(s) })
        .then(() => { status.textContent = "Your responses were sent. Thank you!"; })
        .catch(() => { status.textContent = "Sending failed. Please download your responses and send the file to the team."; });
    } else {
      status.textContent = "Response collection isn't set up yet. Please download your responses and send the file to the team.";
    }

    const download = () => {
      const blob = new Blob([JSON.stringify(s, null, 2)], { type: "application/json" });
      const a = h("a", { href: URL.createObjectURL(blob), download: `response-${s.id.slice(0, 8)}.json` });
      document.body.append(a);
      a.click();
      a.remove();
    };

    const problems = s.trials.filter((t) => !window.SCENARIOS.find((x) => x.id === t.scenario).matches);
    const caught = problems.filter((t) => t.correct).length;

    return h("main", { class: "narrow" },
      h("h1", {}, "Thank you!"),
      status,
      h("div", { class: "actions left" }, h("button", { onclick: download }, "Download my responses")),
      h("h2", {}, `You caught ${caught} of ${problems.length} problem commands`),
      h("p", {}, "Here's what each command actually did:"),
      h("ol", { class: "answers" }, s.trials.map((t) => {
        const sc = window.SCENARIOS.find((x) => x.id === t.scenario);
        return h("li", { class: t.correct ? "right" : "wrong" },
          h("div", {}, h("code", {}, sc.command)),
          h("div", { class: "fine" }, `${t.condition === "baseline" ? "Plain prompt" : "File preview"} · you chose ${t.decision === "change" ? "request change" : t.decision} · ${t.correct ? "✓" : "✗"}`),
          h("div", {}, sc.issue));
      })),
      h("p", {}, h("a", { href: "#demo" }, "Explore all scenarios in the demo →")));
  }

  // ---------- routing ----------

  // shared with playground.js
  window.UI = { h, baselineView, structuredView, fmtSize, fmtDate, chip };

  function route() {
    const r = location.hash.replace("#", "");
    if (r === "try") window.Playground(app);
    else if (r === "demo") demo();
    else if (r === "survey") survey();
    else home();
  }
  window.addEventListener("hashchange", route);
  route();
})();
