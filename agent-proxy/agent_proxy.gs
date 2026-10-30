// Model proxy for the interactive prototype. The page sends a request plus the
// mock file tree; this asks a model which shell commands an agent would run and
// returns them. The API key stays here, in Script Properties, never in the page.
//
// Script Properties (Project Settings -> Script properties):
//   LLM_API_KEY   required. A Claude API key, or a TritonAI key.
//   LLM_PROVIDER  "anthropic" (default) or "openai" for an OpenAI-compatible
//                 gateway such as TritonAI.
//   LLM_MODEL     default "claude-opus-5-5" for Claude, "api-glm-5.3-flash" for TritonAI.
//   LLM_BASE_URL  OpenAI-compatible base URL, e.g. https://tritonai-api.ucsd.edu/v1
//   DAILY_LIMIT   max model calls per day (default 300), to cap spending.

const SYSTEM_PROMPT = [
  "You are a coding agent with shell access to the user's home folder.",
  "The user gives you a request and a listing of every file in the folder.",
  "Decide which shell commands you would run to carry out the request, exactly as you would run them, from the home folder.",
  "Use paths relative to the home folder. Prefer plain commands such as rm, cp, mv and mkdir over scripts.",
  "If the request needs no file changes, return an empty command list and answer in reply.",
  "reply is the short message you would show the user before running the commands.",
  "For each command, purpose is a one-line description of what it does, as you would describe it to the user.",
].join(" ");

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    commands: {
      type: "array",
      items: {
        type: "object",
        properties: { command: { type: "string" }, purpose: { type: "string" } },
        required: ["command", "purpose"],
        additionalProperties: false,
      },
    },
  },
  required: ["reply", "commands"],
  additionalProperties: false,
};

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  const key = PropertiesService.getScriptProperties().getProperty("LLM_API_KEY");
  return json({ ok: true, configured: !!key });
}

function doPost(e) {
  let d;
  try {
    d = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ error: "bad_request" });
  }
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty("LLM_API_KEY");
  if (!key) return json({ error: "not_configured" });

  const request = String(d.request || "").slice(0, 1000).trim();
  const files = Array.isArray(d.files) ? d.files.slice(0, 500) : [];
  if (!request) return json({ error: "empty_request" });
  if (!underDailyLimit(props)) return json({ error: "daily_limit" });

  const listing = files.map((f) => {
    const path = String(f.path || "").slice(0, 300);
    return path.endsWith("/") ? path : `${path}  (${f.size || 0} bytes, modified ${f.mtime || "unknown"})`;
  }).join("\n");
  const userText = `Today is ${String(d.today || "").slice(0, 40)}.\n\nFiles in the home folder:\n${listing}\n\nRequest: ${request}`;

  try {
    const provider = (props.getProperty("LLM_PROVIDER") || "anthropic").toLowerCase();
    const plan = provider === "openai" ? askOpenAICompatible(props, key, userText) : askClaude(props, key, userText);
    return json(plan);
  } catch (err) {
    return json({ error: "model_error", detail: String(err.message || err).slice(0, 300) });
  }
}

// Claude Messages API over raw HTTP (Apps Script has no Anthropic SDK).
function askClaude(props, key, userText) {
  const body = {
    model: props.getProperty("LLM_MODEL") || "claude-opus-5-5",
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    output_config: { effort: "low", format: { type: "json_schema", schema: PLAN_SCHEMA } },
    fallbacks: "default",
    messages: [{ role: "user", content: userText }],
  };
  const res = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "post",
    contentType: "application/json",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2026-10-21",
      "anthropic-beta": "server-side-fallback-2026-07-01",
    },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const data = JSON.parse(res.getContentText());
  if (code !== 200) throw new Error(`Claude API ${code}: ${(data.error && data.error.message) || "error"}`);
  if (data.stop_reason === "refusal") return { reply: "The model declined this request.", commands: [], refused: true };
  if (data.stop_reason === "max_tokens") throw new Error("Claude ran out of output tokens");
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return { ...JSON.parse(text), model: data.model };
}

// OpenAI-compatible chat completions, e.g. the UCSD TritonAI gateway.
function askOpenAICompatible(props, key, userText) {
  const base = (props.getProperty("LLM_BASE_URL") || "https://tritonai-api.ucsd.edu/v1").replace(/\/+$/, "");
  const model = props.getProperty("LLM_MODEL") || "api-glm-5.3-flash";
  const instructions = SYSTEM_PROMPT + ' Answer with only a JSON object of the form {"reply": string, "commands": [{"command": string, "purpose": string}]} and nothing else.';
  const res = UrlFetchApp.fetch(base + "/chat/completions", {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + key },
    payload: JSON.stringify({
      model,
      messages: [{ role: "system", content: instructions }, { role: "user", content: userText }],
    }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const data = JSON.parse(res.getContentText());
  if (code !== 200) throw new Error(`Gateway ${code}: ${(data.error && (data.error.message || data.error)) || "error"}`);
  const text = data.choices[0].message.content || "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const plan = JSON.parse(text.slice(start, end + 1));
  return { reply: String(plan.reply || ""), commands: (plan.commands || []).filter((c) => c && c.command), model };
}

function underDailyLimit(props) {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const limit = Number(props.getProperty("DAILY_LIMIT") || 300);
    const day = "count-" + Utilities.formatDate(new Date(), "America/Los_Angeles", "yyyy-MM-dd");
    const n = Number(props.getProperty(day) || 0);
    if (n >= limit) return false;
    props.setProperty(day, String(n + 1));
    return true;
  } finally {
    lock.releaseLock();
  }
}

// Run once from the editor (Run -> authorize) to grant the external-request permission.
function authorize() {
  UrlFetchApp.fetch("https://www.google.com", { muteHttpExceptions: true });
}
