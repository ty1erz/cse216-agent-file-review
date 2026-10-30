// Interactive prototype. The user types a request; a model, given the mock file
// tree, proposes the shell commands an agent would run (through the proxy in
// agent-proxy/). Commands that change files are previewed before approval;
// Approve applies them to the mock files and Undo reverts.

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

  // ---------- understanding commands ----------

  // Parse a simple sequence while preserving whether each step follows `&&`
  // (run only after success) or `;` / a newline (run regardless). More complex
  // shell syntax remains inside a step and is conservatively blocked below.
  function parseCommandSequence(line) {
    const parts = [];
    let cur = "", quote = null, escaped = false, nextConnector = null, parseError = "";
    const pushCommand = () => {
      if (!cur.trim()) return false;
      parts.push({ cmd: cur.trim(), connector: nextConnector });
      cur = "";
      nextConnector = null;
      return true;
    };

    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (escaped) { cur += c; escaped = false; continue; }
      if (c === "\\") { cur += c; escaped = true; continue; }
      if (quote) { if (c === quote) quote = null; cur += c; continue; }
      if (c === '"' || c === "'") { quote = c; cur += c; continue; }
      if (c === "&" && line[i + 1] === "&") {
        if (!pushCommand()) parseError ||= "The command has && without a command before it.";
        else nextConnector = "&&";
        i++;
        continue;
      }
      if (c === ";") {
        if (!pushCommand()) parseError ||= "The command has an empty step between semicolons.";
        else nextConnector = ";";
        continue;
      }
      if (c === "\n") {
        if (pushCommand()) nextConnector = ";";
        continue;
      }
      cur += c;
    }
    const endedWithCommand = pushCommand();
    if (!endedWithCommand && nextConnector === "&&") parseError ||= "The command ends with && and has no following command.";
    if (quote || escaped) parseError ||= "The command contains an unfinished quote or escape.";
    if (parseError) parts.parseError = parseError;
    return parts;
  }

  function splitCommands(line) {
    return parseCommandSequence(line).map((part) => part.cmd);
  }

  const PREVIEWABLE = new Set(["rm", "cp", "mv", "mkdir"]);
  const READ_ONLY = new Set(["ls", "pwd", "cat", "head", "tail", "stat", "file", "du", "wc", "grep", "rg", "echo", "printf", "true"]);
  const SAFE_GIT = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files"]);

  // Replace quoted text with spaces so shell operators inside a filename or a
  // message do not affect classification. Return whether the quoting itself is
  // complete; incomplete input is never safe to preview or auto-run.
  function maskQuoted(command) {
    let out = "", quote = null, escaped = false, hasEscape = false;
    for (const c of command) {
      if (escaped) { out += " "; escaped = false; continue; }
      if (c === "\\" && quote !== "'") { out += " "; escaped = true; hasEscape = true; continue; }
      if (quote) {
        if (c === quote) quote = null;
        // Command and variable substitution remain active inside double quotes.
        out += quote === '"' && (c === "$" || c === "`") ? c : " ";
        continue;
      }
      if (c === '"' || c === "'") { quote = c; out += " "; continue; }
      out += c;
    }
    return { text: out, complete: !quote && !escaped, hasEscape };
  }

  function commandWords(command) {
    const words = [];
    let cur = "", quote = null, escaped = false;
    for (const c of command.trim()) {
      if (escaped) { cur += c; escaped = false; continue; }
      if (c === "\\" && quote !== "'") { escaped = true; continue; }
      if (quote) { if (c === quote) quote = null; else cur += c; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (/\s/.test(c)) { if (cur) { words.push(cur); cur = ""; } }
      else cur += c;
    }
    if (cur) words.push(cur);
    return words;
  }

  // previewable: we can simulate it. changes: it is not proven read-only and
  // must be blocked. readonly: an explicitly supported read-only command.
  function classify(command) {
    const masked = maskQuoted(command);
    const words = commandWords(command);
    const name = words[0] || "";
    const unsupportedShell = /&&|;|\n|\|\||[|`<>$~{}#]|(^|[^&])&(?!&)/.test(masked.text);
    if (!masked.complete) return { kind: "changes", name, reason: "has unfinished quoting" };
    if (!name) return { kind: "changes", name, reason: "is empty" };
    if (masked.hasEscape) return { kind: "changes", name, reason: "uses backslash escaping this prototype does not simulate" };
    if (unsupportedShell) return { kind: "changes", name, reason: "uses shell syntax this prototype cannot safely preview" };
    if (name.includes("/") || /^\w+=/.test(name) || ["sudo", "env", "command", "time", "nohup"].includes(name)) {
      return { kind: "changes", name, reason: "uses a wrapper or executable form this prototype does not simulate" };
    }
    if (PREVIEWABLE.has(name)) return { kind: "previewable", name };
    if (READ_ONLY.has(name)) {
      if (name === "rg" && words.some((word) => word === "--pre" || word.startsWith("--pre="))) {
        return { kind: "changes", name, reason: "can run an external command through rg --pre" };
      }
      const alwaysSucceeds = name === "true" || (name === "pwd" && words.slice(1).every((word) => word === "-L" || word === "-P"));
      return { kind: "readonly", name, alwaysSucceeds };
    }
    const unsafeGitOption = words.some((word) =>
      word === "-o" || word === "--output" || word.startsWith("--output=") || word === "--ext-diff" || word === "--textconv");
    if (name === "git" && SAFE_GIT.has(words[1] || "") && !unsafeGitOption) {
      return { kind: "readonly", name, alwaysSucceeds: false };
    }
    return { kind: "changes", name, reason: "is not on the supported read-only list" };
  }

  function simulateSequence(command, initialFiles) {
    const parsed = parseCommandSequence(command);
    let files = initialFiles;
    let priorSucceeded = true;
    let stateUnknown = false;
    let blocked = !!parsed.parseError;
    const steps = [];

    for (const part of parsed) {
      const cls = classify(part.cmd);
      if (part.connector === "&&" && priorSucceeded === false) {
        steps.push({ ...part, cls, skipped: true, skipReason: "the previous command failed" });
        continue;
      }
      if (part.connector === "&&" && priorSucceeded == null) {
        blocked = true;
        steps.push({ ...part, cls, skipped: true, skipReason: "the previous read-only command's exit status cannot be determined" });
        continue;
      }
      if (stateUnknown) {
        blocked = true;
        steps.push({ ...part, cls, skipped: true, skipReason: "an earlier unsupported command may have changed the files" });
        continue;
      }
      if (cls.kind === "readonly") {
        priorSucceeded = cls.alwaysSucceeds ? true : null;
        steps.push({ ...part, cls, success: priorSucceeded });
        continue;
      }
      if (cls.kind === "changes") {
        blocked = true;
        stateUnknown = true;
        priorSucceeded = null;
        steps.push({ ...part, cls, success: null });
        continue;
      }

      const r = Engine.simulate(files, part.cmd);
      const failed = !!r.blocked || r.errors.length > 0;
      blocked ||= failed;
      priorSucceeded = !failed;
      // A normal shell command can make partial changes before returning a
      // non-zero status. Keep those changes in the preview, but block Approve.
      if (!r.blocked) files = treeToFiles(r.after);
      steps.push({ ...part, cls, r, success: !failed });
    }

    return {
      steps,
      finalFiles: files,
      blocked,
      parseError: parsed.parseError || "",
      expression: parsed.map((part, i) => `${i ? ` ${part.connector || ";"} ` : ""}${part.cmd}`).join(""),
    };
  }

  function createRequestCoordinator() {
    let generation = 0;
    let controller = null;
    return {
      start() {
        if (controller) controller.abort();
        controller = new AbortController();
        return { generation: ++generation, signal: controller.signal };
      },
      invalidate() {
        generation++;
        if (controller) controller.abort();
        controller = null;
      },
      isCurrent(ticket) {
        return !!ticket && ticket.generation === generation && !ticket.signal.aborted;
      },
      finish(ticket) {
        if (this.isCurrent(ticket)) controller = null;
      },
    };
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
    // Files the request names ("rename report_v2.docx") or describes ("my screenshots"
    // matches "Screenshot 2026-10-21.png") put their folder in scope.
    const stems = (text.match(/[a-z0-9_.-]{4,}/g) || []).map((w) => w.replace(/s$/, ""));
    const fromFiles = new Set();
    for (const p of tree.files.keys()) {
      const dir = Engine.parentOf(p);
      const base = Engine.baseName(p).toLowerCase();
      if (dir && (text.includes(base) || stems.some((s) => base.startsWith(s)))) fromFiles.add(dir);
    }
    for (const d of fromFiles) if (!hits.includes(d)) hits.push(d);
    return hits.filter((d) => {
      if (fromFiles.has(d)) return true;
      const children = hits.filter((o) => o !== d && o.startsWith(d + "/"));
      if (!children.length) return true;
      let rest = text;
      for (const c of children) rest = rest.split(c.toLowerCase()).join(" ");
      return mentions(rest, d);
    }).sort();
  }

  // Fallback description when the model gave none (e.g. a command typed by hand).
  function describe(command) {
    const words = command.trim().split(/\s+/);
    const name = words[0];
    const args = words.slice(1).filter((w) => !w.startsWith("-"));
    if (name === "rm") return `Removes ${args.join(" ") || "the files"}.`;
    if (name === "mkdir") return `Creates the folder ${args.join(" ")}.`;
    if (name === "cp" && args.length > 1) return `Copies ${args.slice(0, -1).join(" ")} to ${args[args.length - 1]}.`;
    if (name === "mv" && args.length > 1) return `Moves ${args.slice(0, -1).join(" ")} to ${args[args.length - 1]}.`;
    return `Runs ${name || "the command"}.`;
  }

  const EXAMPLES = [
    "Delete my drafts in docs/drafts, I don't need them anymore",
    "Copy the new photos from camera into my photos library",
    "Move the invoice PDFs from Downloads into finance/2026",
    "Clean up old log files but keep today's",
    "Put my screenshots into a folder by date",
  ];

  const AGENT_ERRORS = {
    not_configured: "The model isn't connected yet (no API key on the proxy). You can still type commands yourself below.",
    daily_limit: "Today's limit of model requests has been reached. You can still type commands yourself below.",
    empty_request: "Type a request first.",
    model_error: "The model call failed.",
    network: "Couldn't reach the model proxy. It may not be set up yet. You can still type commands yourself below.",
    timeout: "The model proxy did not respond within 20 seconds. Try again, or type the commands yourself below.",
    not_authorized: "The model proxy hasn't been authorized by its owner yet. You can still type commands yourself below.",
  };

  async function askAgent(request, files, options = {}) {
    const url = window.SURVEY_CONFIG.agentUrl;
    if (!url) return { error: "not_configured" };
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs == null ? 20000 : options.timeoutMs;
    let timedOut = false;
    const relayAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) return { error: "cancelled" };
      options.signal.addEventListener("abort", relayAbort, { once: true });
    }
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ request, files, today: window.TODAY }),
        signal: controller.signal,
      });
      if (!res.ok) return { error: "network", detail: `The proxy returned HTTP ${res.status}.` };
      const text = await res.text();
      try { return JSON.parse(text); } catch (e) { return { error: "not_authorized" }; }
    } catch (e) {
      if (options.signal && options.signal.aborted) return { error: "cancelled" };
      if (timedOut) return { error: "timeout" };
      return { error: "network" };
    } finally {
      clearTimeout(timeout);
      if (options.signal) options.signal.removeEventListener("abort", relayAbort);
    }
  }

  function normalizePlan(plan) {
    if (!plan || typeof plan !== "object") return { error: "model_error", detail: "The model proxy returned an invalid plan." };
    if (plan.error) return { error: String(plan.error), detail: plan.detail == null ? "" : String(plan.detail) };
    if (!Array.isArray(plan.commands)
      || plan.commands.some((command) => !command || typeof command !== "object" || typeof command.command !== "string")) {
      return { error: "model_error", detail: "The model proxy returned an invalid plan." };
    }
    return {
      commands: plan.commands.map((command) => ({ command: command.command.trim(), purpose: String(command.purpose || "") })).filter((command) => command.command),
      model: plan.model == null ? "" : String(plan.model),
      refused: !!plan.refused,
      reply: plan.reply == null ? "" : String(plan.reply),
    };
  }

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
      scope: "",
      scopeEdited: false,
      agent: { status: "idle" },  // idle | loading | done | error
      purposes: new Map(),        // command -> the agent's own description
    };
    const requests = createRequestCoordinator();
    let disposed = false;
    let playRoot = null;

    const filesPanel = h("div", { class: "play-files" });
    const agentArea = h("div", { class: "agent-area", "aria-live": "polite" });
    const output = h("div", { class: "play-output", "aria-live": "polite" });
    const requestBox = h("textarea", { rows: 2, placeholder: "e.g. Delete my drafts in docs/drafts", "aria-label": "Your request to the agent" });
    const askButton = h("button", { class: "primary", onclick: () => ask() }, "Ask the agent");
    const scopeBox = h("input", { type: "text", placeholder: "folders, separated by commas", "aria-label": "Folders the request is about" });
    const scopeHint = h("span", { class: "fine" });
    const commandBox = h("textarea", { rows: 3, class: "cmd-input", spellcheck: "false", placeholder: "The agent's commands appear here. You can also type or edit them, one per line.", "aria-label": "Commands the agent proposes" });

    let timer = null;
    const later = () => { clearTimeout(timer); timer = setTimeout(renderOutput, 200); };

    requestBox.addEventListener("input", () => {
      const changed = requestBox.value !== state.request;
      state.request = requestBox.value;
      if (changed) {
        requests.invalidate();
        state.agent = { status: "idle" };
        if (state.command) setCommands([]);
        renderAgent();
      }
      if (!state.scopeEdited) syncScope();
    });
    requestBox.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } });
    scopeBox.addEventListener("input", () => { state.scope = scopeBox.value; state.scopeEdited = !!scopeBox.value.trim(); scopeHint.textContent = state.scopeEdited ? "set by you" : ""; later(); });
    const onCommand = () => {
      if (commandBox.value === state.command) return;
      requests.invalidate();
      state.agent = { status: "idle" };
      renderAgent();
      state.command = commandBox.value;
      later();
    };
    commandBox.addEventListener("input", onCommand);
    commandBox.addEventListener("keyup", onCommand); // some input methods skip "input"

    function syncScope() {
      const s = inferScope(state.request, state.files);
      state.scope = s.join(", ");
      scopeBox.value = state.scope;
      scopeHint.textContent = s.length ? "inferred from your request" : state.request ? "no folder found in your request" : "";
    }

    function scopeList() {
      return state.scope.split(",").map((s) => s.trim().replace(/^~\//, "").replace(/^\.\//, "").replace(/\/+$/, "")).filter(Boolean);
    }

    function setCommands(commands) {
      state.command = commandBox.value = commands.join("\n");
      renderOutput();
    }

    async function ask(text) {
      if (text != null) {
        requests.invalidate();
        state.request = requestBox.value = text;
        state.scopeEdited = false;
        syncScope();
      }
      const request = state.request.trim();
      if (!request || disposed) return;
      const ticket = requests.start();
      state.agent = { status: "loading", request };
      setCommands([]);
      renderAgent();
      const files = state.files.map((file) => ({ ...file }));
      const plan = await askAgent(request, files, { signal: ticket.signal });
      if (!requests.isCurrent(ticket) || disposed || !playRoot || !playRoot.isConnected) return;
      requests.finish(ticket);
      const normalized = normalizePlan(plan);
      if (normalized.error) {
        state.agent = { status: "error", error: normalized.error, detail: normalized.detail, request };
      } else {
        const commands = normalized.commands;
        for (const c of commands) state.purposes.set(c.command, c.purpose);
        state.agent = { status: "done", reply: normalized.reply, commands, model: normalized.model, refused: normalized.refused, request };
        setCommands(commands.map((c) => c.command));
      }
      renderAgent();
    }

    // Run every supported step in shell order, honoring `&&` failure stops.
    function simulateAll() {
      return simulateSequence(state.command, state.files);
    }

    function decide(kind, sim, note) {
      if (kind === "approve" && sim.blocked) return;
      const cmd = sim.expression || state.command.trim();
      if (kind === "approve") {
        state.history.push({ files: state.files, label: cmd });
        state.changed = new Set(sim.steps.flatMap(({ r }) => (r ? r.effects.map((e) => e.path) : [])));
        state.files = sim.finalFiles;
        const n = sim.steps.reduce((s, { r }) => s + (r ? r.effects.length : 0), 0);
        state.log.unshift({ kind, text: `Approved ${cmd}: ${n} change${n === 1 ? "" : "s"} applied` });
      } else if (kind === "reject") {
        state.log.unshift({ kind, text: `Rejected ${cmd}` });
      } else {
        state.log.unshift({ kind, text: `Requested a change to ${cmd}` + (note ? `: “${note}”` : "") });
      }
      state.agent = { status: "idle" };
      state.command = commandBox.value = "";
      renderFiles();
      renderAgent();
      renderOutput();
      if (kind === "change" && note) ask(`${state.request.trim()} (${note})`);
    }

    function undo() {
      const last = state.history.pop();
      if (!last) return;
      requests.invalidate();
      state.agent = { status: "idle" };
      setCommands([]);
      state.files = last.files;
      state.changed = new Set();
      state.log.unshift({ kind: "undo", text: `Undid ${last.label}` });
      renderFiles();
      renderAgent();
      renderOutput();
    }

    function switchSpace(id) {
      requests.invalidate();
      state.space = spaces.find((s) => s.id === id);
      state.files = state.space.files.slice();
      state.history = [];
      state.changed = new Set();
      state.agent = { status: "idle" };
      state.log.unshift({ kind: "undo", text: `Loaded ${state.space.id === "home" ? "the home folder" : "a scenario workspace"}` });
      state.request = requestBox.value = state.space.request || "";
      state.scopeEdited = false;
      syncScope();
      renderFiles();
      renderAgent();
      setCommands([]);
    }

    function dispose() {
      disposed = true;
      requests.invalidate();
      clearTimeout(timer);
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
        ...state.log.length ? [h("div", { class: "play-log" },
          h("div", { class: "panel-title" }, "Activity"),
          h("ul", {}, state.log.slice(0, 8).map((l) => h("li", { class: "log-" + l.kind }, l.text))))] : []);
    }

    // ---------- the agent's answer ----------

    const KIND_LABEL = {
      previewable: ["changes files", "badge-change", "previewed below"],
      changes: ["changes files", "badge-warn", "can't be previewed"],
      readonly: ["read only", "badge-read", "doesn't change files"],
    };

    function renderAgent() {
      askButton.disabled = state.agent.status === "loading";
      askButton.textContent = state.agent.status === "loading" ? "Asking…" : "Ask the agent";
      const a = state.agent;
      if (a.status === "idle") { agentArea.replaceChildren(); return; }
      if (a.status === "loading") {
        agentArea.replaceChildren(h("div", { class: "agent-msg loading" }, "The agent is reading your files and planning commands…"));
        return;
      }
      if (a.status === "error") {
        agentArea.replaceChildren(h("div", { class: "agent-msg error" },
          AGENT_ERRORS[a.error] || "Something went wrong.", a.detail ? h("div", { class: "fine" }, a.detail) : null));
        return;
      }
      const rows = a.commands.map((c) => {
        const classification = classify(c.command);
        const [label, cls, note] = KIND_LABEL[classification.kind];
        return h("li", {},
          h("code", {}, c.command),
          h("span", { class: "badge " + cls }, label),
          h("span", { class: "fine" }, " " + (classification.reason ? `${note}: ${classification.reason}` : note)),
          c.purpose ? h("div", { class: "fine" }, c.purpose) : null);
      });
      agentArea.replaceChildren(h("div", { class: "agent-msg" },
        h("div", { class: "eyebrow" }, "Agent" + (a.model ? ` · ${a.model}` : "")),
        h("p", {}, a.reply || (a.commands.length ? "" : "The agent proposed no commands.")),
        rows.length ? h("ul", { class: "agent-cmds" }, rows) : null));
    }

    // ---------- the review screens ----------

    function renderOutput() {
      const cmd = state.command.trim();
      if (!cmd) {
        output.replaceChildren(state.agent.status === "loading" ? "" : h("div", { class: "play-empty" },
          h("p", {}, "Ask the agent to do something with the files on the left. If its commands change files, you'll see what they would do before deciding."),
          h("p", { class: "fine" }, "Nothing runs on your computer. Approving only changes the mock files.")));
        return;
      }
      const sim = simulateAll();
      const scope = scopeList();
      const base = { request: state.request || "(no request given)", scope };
      const changing = sim.steps.filter((s) => s.cls.kind !== "readonly");

      if (!changing.length) {
        output.replaceChildren(h("div", { class: "play-empty" },
          h("p", {}, "None of these commands change files, so there is nothing to review. An agent would run them without asking.")));
        return;
      }

      const views = [];
      sim.steps.forEach((s, i) => {
        const title = sim.steps.length > 1 ? h("div", { class: "step-title" }, `Step ${i + 1} of ${sim.steps.length}`) : null;
        if (s.skipped) {
          views.push(h("div", { class: "step" }, title, h("div", { class: "step-note warn" },
            h("code", {}, s.cmd), ` would not be run because ${s.skipReason}.`)));
          return;
        }
        if (s.cls.kind === "readonly") {
          views.push(h("div", { class: "step" }, title, h("div", { class: "step-note" }, h("code", {}, s.cmd), " reads files only; no review needed.")));
          return;
        }
        if (s.cls.kind === "changes") {
          views.push(h("div", { class: "step" }, title, h("div", { class: "step-note warn" },
            h("code", {}, s.cmd),
            ` is blocked because it ${s.cls.reason || "cannot be proven read-only or faithfully previewed"}. Ask the agent to rewrite it, or reject it.`)));
          return;
        }
        if (s.r && s.r.blocked) {
          views.push(h("div", { class: "step" }, title, h("div", { class: "step-note warn" },
            h("code", {}, s.cmd), " cannot be faithfully previewed. ", (s.r.errors || []).join(" "))));
          return;
        }
        const sc = { ...base, command: s.cmd, agentSays: state.purposes.get(s.cmd) || describe(s.cmd), files: null };
        const plain = baselineView(sc);
        const rich = structuredView(sc, s.r);
        const body = state.view === "baseline" ? plain : state.view === "structured" ? rich : h("div", { class: "both" }, plain, rich);
        views.push(h("div", { class: "step" }, title, body));
      });

      const blocked = sim.blocked;
      const note = h("textarea", { rows: 2, placeholder: "What should the agent do instead?", "aria-label": "Requested change" });
      const sendChange = h("button", { class: "primary", disabled: true }, "Send to agent");
      note.addEventListener("input", () => { sendChange.disabled = !note.value.trim(); });
      sendChange.addEventListener("click", () => {
        const requested = note.value.trim();
        if (requested) decide("change", sim, requested);
      });
      const changeBox = h("div", { class: "change-box", hidden: true }, note,
        sendChange);

      output.replaceChildren(
        ...views,
        h("div", { class: "decide" },
          h("button", { class: "decision decision-approve", disabled: blocked, title: blocked ? "Some commands cannot be faithfully previewed or would fail" : null, onclick: () => decide("approve", sim) }, "Approve"),
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

    playRoot = h("main", { class: "play" },
        filesPanel,
        h("div", { class: "play-main" },
          h("section", { class: "request play-input" },
            h("label", { class: "eyebrow" }, "Ask the agent to do something with your files"),
            h("div", { class: "ask-row" }, requestBox, askButton),
            h("div", { class: "examples" },
              h("span", { class: "fine" }, "Try:"),
              EXAMPLES.map((ex) => h("button", { class: "example", onclick: () => ask(ex) }, ex))),
            agentArea,
            h("details", { class: "advanced" },
              h("summary", {}, "Edit the commands or the folders in scope"),
              h("label", { class: "eyebrow" }, "Commands (one per line)"),
              commandBox,
              h("label", { class: "eyebrow" }, "Folders your request is about ", scopeHint),
              scopeBox)),
          h("div", { class: "toolbar" }, viewSeg, h("span", { class: "fine" }, "Mock workspace date: " + window.TODAY)),
          output));
    app.replaceChildren(
      h("header", { class: "bar" }, h("a", { href: "#" }, "← Home"), h("span", {}, "Prototype")),
      playRoot);

    renderFiles();
    renderAgent();
    renderOutput();
    return dispose;
  };

  // exposed for testing in the console
  window.Playground.internals = {
    askAgent,
    classify,
    createRequestCoordinator,
    describe,
    inferScope,
    maskQuoted,
    normalizePlan,
    parseCommandSequence,
    simulateSequence,
    splitCommands,
    treeToFiles,
  };
})();
