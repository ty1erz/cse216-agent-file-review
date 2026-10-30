// Interactive prototype: type any rm / cp / mv command against a mock file
// system and see the plain prompt and the file preview computed from it.
// Approve applies the change to the mock files; Undo reverts it.

(function () {
  "use strict";

  // ---------- workspace helpers ----------

  function mergeFiles(lists) {
    const seen = new Map();
    for (const list of lists) for (const f of list) if (!seen.has(f.path)) seen.set(f.path, f);
    return [...seen.values()];
  }

  // FileTree -> plain file list, keeping empty folders as "dir/" entries.
  function treeToFiles(tree) {
    const out = [...tree.files].map(([path, meta]) => ({ path, ...meta }));
    for (const d of tree.dirs) if (d && !tree.children(d).length) out.push({ path: d + "/" });
    return out;
  }

  function workspaces() {
    const list = [{ id: "home", label: "Home folder (all scenario files)", files: mergeFiles(window.SCENARIOS.map((s) => s.files)) }];
    for (const s of window.SCENARIOS) list.push({ id: s.id, label: "Scenario: " + s.request, files: s.files, request: s.request, command: s.command });
    return list;
  }

  // ---------- understanding the input ----------

  // Split "a && b; c" into separate commands, ignoring separators inside quotes.
  function splitCommands(line) {
    const parts = [];
    let cur = "", quote = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) { if (c === quote) quote = null; cur += c; continue; }
      if (c === '"' || c === "'") { quote = c; cur += c; continue; }
      if (c === ";" || c === "\n" || (c === "&" && line[i + 1] === "&")) {
        if (c === "&") i++;
        if (cur.trim()) parts.push(cur.trim());
        cur = "";
        continue;
      }
      cur += c;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
  }

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  // Folders the request mentions, by full path ("docs/drafts") or by name ("Desktop").
  // A parent that only appears inside a child's path ("docs" in "docs/drafts") is dropped.
  function inferScope(request, files) {
    const text = " " + request.toLowerCase() + " ";
    const tree = new Engine.FileTree(files);
    const dirs = [...tree.dirs].filter(Boolean);
    const mentions = (t, d) => {
      const full = new RegExp("(^|[^\\w/])" + escapeRe(d.toLowerCase()) + "(?![\\w])");
      const name = Engine.baseName(d).toLowerCase();
      const word = name.length >= 3 && new RegExp("(^|[^\\w/])" + escapeRe(name) + "(?![\\w])");
      return full.test(t) || (word && word.test(t));
    };
    const hits = dirs.filter((d) => mentions(text, d));
    // a file named in the request ("rename report_v2.docx") puts its folder in scope
    for (const p of tree.files.keys()) {
      const dir = Engine.parentOf(p);
      if (dir && !hits.includes(dir) && text.includes(Engine.baseName(p).toLowerCase())) hits.push(dir);
    }
    return hits.filter((d) => {
      const children = hits.filter((o) => o !== d && o.startsWith(d + "/"));
      if (!children.length) return true;
      let rest = text;
      for (const c of children) rest = rest.split(c.toLowerCase()).join(" ");
      return mentions(rest, d);
    }).sort();
  }

  // What a typical agent would say about its own command (shown on the plain prompt).
  function describe(command) {
    const words = command.trim().split(/\s+/);
    const name = words[0];
    const args = words.slice(1).filter((w) => !w.startsWith("-"));
    if (name === "rm") return `Removes ${args.join(" ") || "the files"}.`;
    if (name === "cp" && args.length > 1) return `Copies ${args.slice(0, -1).join(" ")} to ${args[args.length - 1]}.`;
    if (name === "mv" && args.length > 1) return `Moves ${args.slice(0, -1).join(" ")} to ${args[args.length - 1]}.`;
    return `Runs ${name || "the command"}.`;
  }

  const EXAMPLES = [
    { request: "Delete my drafts in docs/drafts. I don't need them anymore.", command: "rm -r docs/*" },
    { request: "Copy the new photos from camera/ into my photos/ library.", command: "cp camera/* photos/" },
    { request: "Move the invoice PDFs from Downloads into finance/2026/.", command: "mv Downloads/*.pdf finance/2026/" },
    { request: "Clean up the .tmp files in build/ and the old logs.", command: "rm build/*.tmp && rm logs/server-2026-10-2[0-1].log" },
  ];

  // ---------- the page ----------

  window.Playground = function (app) {
    const { h, baselineView, structuredView, fmtSize, fmtDate } = window.UI;
    const spaces = workspaces();
    const state = {
      space: spaces[0],
      files: spaces[0].files.slice(),
      history: [],   // { label, files } snapshots for undo
      log: [],       // what happened, newest first
      changed: new Set(),
      view: "structured",
      request: "",
      command: "",
      scopeEdited: false,
      scope: "",
    };

    const filesPanel = h("div", { class: "play-files" });
    const output = h("div", { class: "play-output", "aria-live": "polite" });
    const requestBox = h("textarea", { rows: 2, placeholder: "e.g. Delete my drafts in docs/drafts", "aria-label": "Your request to the agent" });
    const scopeBox = h("input", { type: "text", placeholder: "folders, separated by commas", "aria-label": "Folders the request is about" });
    const commandBox = h("textarea", { rows: 2, class: "cmd-input", spellcheck: "false", placeholder: "e.g. rm -r docs/*", "aria-label": "Command the agent proposes" });
    const scopeHint = h("span", { class: "fine" });

    let timer = null;
    const later = () => { clearTimeout(timer); timer = setTimeout(renderOutput, 200); };

    requestBox.addEventListener("input", () => { state.request = requestBox.value; if (!state.scopeEdited) syncScope(); later(); });
    scopeBox.addEventListener("input", () => { state.scope = scopeBox.value; state.scopeEdited = !!scopeBox.value.trim(); scopeHint.textContent = state.scopeEdited ? "set by you" : ""; later(); });
    commandBox.addEventListener("input", () => { state.command = commandBox.value; later(); });
    // some input methods skip "input"; keyup catches those
    commandBox.addEventListener("keyup", () => { if (commandBox.value !== state.command) { state.command = commandBox.value; later(); } });
    commandBox.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); renderOutput(); } });

    function syncScope() {
      const s = inferScope(state.request, state.files);
      state.scope = s.join(", ");
      scopeBox.value = state.scope;
      scopeHint.textContent = s.length ? "inferred from your request" : state.request ? "no folder found in your request" : "";
    }

    function scopeList() {
      return state.scope.split(",").map((s) => s.trim().replace(/^~\//, "").replace(/^\.\//, "").replace(/\/+$/, "")).filter(Boolean);
    }

    function setInput(request, command) {
      state.request = requestBox.value = request || "";
      state.command = commandBox.value = command || "";
      state.scopeEdited = false;
      syncScope();
      renderOutput();
    }

    // Run every step in order, each on the result of the previous one.
    function simulateAll() {
      const steps = splitCommands(state.command);
      let files = state.files;
      const results = [];
      for (const cmd of steps) {
        const r = Engine.simulate(files, cmd);
        results.push({ cmd, r });
        files = treeToFiles(r.after);
      }
      return { steps: results, finalFiles: files };
    }

    function decide(kind, sim) {
      const cmd = state.command.trim();
      if (kind === "approve") {
        state.history.push({ files: state.files, label: cmd });
        state.changed = new Set(sim.steps.flatMap(({ r }) => r.effects.map((e) => e.path)));
        state.files = sim.finalFiles;
        const n = sim.steps.reduce((s, { r }) => s + r.effects.length, 0);
        state.log.unshift({ kind, text: `Approved ${cmd}: ${n} change${n === 1 ? "" : "s"} applied` });
      } else if (kind === "reject") {
        state.log.unshift({ kind, text: `Rejected ${cmd}` });
      } else {
        state.log.unshift({ kind, text: `Requested a change to ${cmd}` + (sim.note ? `: “${sim.note}”` : "") });
      }
      state.command = commandBox.value = "";
      renderFiles();
      renderOutput();
      commandBox.focus();
    }

    function undo() {
      const last = state.history.pop();
      if (!last) return;
      state.files = last.files;
      state.changed = new Set();
      state.log.unshift({ kind: "undo", text: `Undid ${last.label}` });
      renderFiles();
      renderOutput();
    }

    function switchSpace(id) {
      state.space = spaces.find((s) => s.id === id);
      state.files = state.space.files.slice();
      state.history = [];
      state.changed = new Set();
      state.log.unshift({ kind: "undo", text: `Loaded ${state.space.id === "home" ? "the home folder" : "a scenario workspace"}` });
      renderFiles();
      setInput(state.space.request || "", state.space.command || "");
    }

    // ---------- left: the mock file manager ----------

    function renderFiles() {
      const tree = new Engine.FileTree(state.files);
      function walk(dir) {
        return tree.children(dir).map((name) => {
          const p = dir ? dir + "/" + name : name;
          if (tree.isDir(p)) {
            const kids = walk(p);
            return h("details", { open: true, class: "fm-dir" },
              h("summary", {}, h("span", { class: "name" }, name + "/"), h("span", { class: "meta" }, kids.length ? "" : "empty")),
              h("div", { class: "fm-kids" }, kids));
          }
          const meta = tree.files.get(p);
          return h("div", { class: "fm-file" + (state.changed.has(p) ? " flash" : "") },
            h("span", { class: "name" }, name),
            h("span", { class: "meta" }, [fmtDate(meta.mtime), fmtSize(meta.size)].filter(Boolean).join(" · ")));
        });
      }
      const select = h("select", { "aria-label": "Workspace", onchange: (e) => switchSpace(e.target.value) },
        spaces.map((s) => h("option", { value: s.id, selected: s === state.space }, s.label)));

      filesPanel.replaceChildren(
        h("div", { class: "panel-title" }, "Mock file system"),
        select,
        h("div", { class: "fm-tree" }, walk("")),
        h("div", { class: "fm-actions" },
          h("button", { onclick: undo, disabled: !state.history.length }, "Undo last approve"),
          h("button", { onclick: () => switchSpace(state.space.id) }, "Reset files")),
        state.log.length ? h("div", { class: "play-log" },
          h("div", { class: "panel-title" }, "Activity"),
          h("ul", {}, state.log.slice(0, 8).map((l) => h("li", { class: "log-" + l.kind }, l.text)))) : null);
    }

    // ---------- right: the review screens ----------

    function renderOutput() {
      const cmd = state.command.trim();
      if (!cmd) {
        output.replaceChildren(h("div", { class: "play-empty" },
          h("p", {}, "Type a command above to see what it would do. The prototype understands rm, cp and mv, with -r, -f, wildcards (* ? [ ]), quoted names and chains with && or ;."),
          h("p", { class: "fine" }, "Nothing runs on your computer. Approving only changes the mock files on the left.")));
        return;
      }
      const sim = simulateAll();
      const scope = scopeList();
      const base = { request: state.request || "(no request given)", scope, agentSays: "" };

      const views = sim.steps.map(({ cmd: step, r }, i) => {
        const sc = { ...base, command: step, agentSays: describe(step), files: null };
        const title = sim.steps.length > 1 ? h("div", { class: "step-title" }, `Step ${i + 1} of ${sim.steps.length}`) : null;
        const plain = baselineView(sc);
        const rich = structuredView(sc, r);
        if (state.view === "baseline") return h("div", { class: "step" }, title, plain);
        if (state.view === "structured") return h("div", { class: "step" }, title, rich);
        return h("div", { class: "step" }, title, h("div", { class: "both" }, plain, rich));
      });

      const unsupported = sim.steps.some(({ r }) => r.errors.some((e) => e.startsWith("This prototype only")));
      const note = h("textarea", { rows: 2, placeholder: "What should the agent do instead?", "aria-label": "Requested change" });
      const changeBox = h("div", { class: "change-box", hidden: true }, note,
        h("button", { class: "primary", onclick: () => decide("change", { ...sim, note: note.value.trim() }) }, "Send to agent"));

      output.replaceChildren(
        ...views,
        h("div", { class: "decide" },
          h("button", { class: "decision decision-approve", disabled: unsupported, title: unsupported ? "Only rm, cp and mv can be applied" : null, onclick: () => decide("approve", sim) }, "Approve"),
          h("button", { class: "decision decision-reject", onclick: () => decide("reject", sim) }, "Reject"),
          h("button", { class: "decision decision-change", onclick: () => { changeBox.hidden = false; note.focus(); } }, "Request change")),
        changeBox);
    }

    // ---------- layout ----------

    const viewSeg = h("div", { class: "seg", role: "group", "aria-label": "Screen" });
    function renderSeg() {
      viewSeg.replaceChildren(...[["baseline", "Plain prompt"], ["structured", "File preview"], ["both", "Side by side"]].map(([v, label]) =>
        h("button", { class: v === state.view ? "on" : "", "aria-pressed": v === state.view ? "true" : "false", onclick: () => { state.view = v; renderSeg(); renderOutput(); } }, label)));
    }
    renderSeg();

    app.replaceChildren(
      h("header", { class: "bar" }, h("a", { href: "#" }, "← Home"), h("span", {}, "Prototype")),
      h("main", { class: "play" },
        filesPanel,
        h("div", { class: "play-main" },
          h("section", { class: "request play-input" },
            h("label", { class: "eyebrow" }, "You ask the agent"),
            requestBox,
            h("label", { class: "eyebrow" }, "Folders your request is about ", scopeHint),
            scopeBox,
            h("label", { class: "eyebrow" }, "The agent proposes this command"),
            commandBox,
            h("div", { class: "examples" },
              h("span", { class: "fine" }, "Examples:"),
              EXAMPLES.map((ex) => h("button", { class: "example", onclick: () => setInput(ex.request, ex.command) }, ex.command)))),
          h("div", { class: "toolbar" }, viewSeg, h("span", { class: "fine" }, "Today is " + window.TODAY)),
          output)));

    renderFiles();
    renderOutput();
  };

  // exposed for testing in the console
  window.Playground.internals = { splitCommands, inferScope, describe, treeToFiles };
})();
