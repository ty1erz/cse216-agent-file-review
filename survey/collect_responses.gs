// Google Apps Script that stores survey responses in the Sheet it's attached to.
// Setup steps are in README.md ("Collecting responses").
//
// Each valid, finished survey adds:
//   - one row to "responses": participant info, ratings, preference, raw JSON
//   - eight rows to "trials": decision, correctness, time, confidence
//
// The participant id is an idempotency key. A receipt is considered saved only
// after both the response row and all eight distinct trial-order rows exist.

const RESPONSE_COLUMNS = [
  "received", "id", "version", "group", "started", "finished",
  "terminal", "agents",
  "plain_affected", "plain_confident", "plain_easy", "plain_toomuch",
  "preview_affected", "preview_confident", "preview_easy", "preview_toomuch",
  "prefer", "why", "missing", "raw_json", "harness",
];
const TRIAL_COLUMNS = [
  "id", "group", "order", "scenario", "screen", "decision", "correct",
  "ms", "confidence", "comment", "harness",
];

const EXPECTED_TRIALS = 8;
// Google Sheets cells top out at 50,000 characters; raw_json stores the body.
const MAX_BODY_CHARS = 45000;
const MAX_TEXT_CHARS = 5000;
const ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const GROUPS = ["A1", "A2", "B1", "B2"];
const HARNESSES = ["openhands", "cline", "codex"];
const CONDITIONS = ["baseline", "structured"];
const DECISIONS = ["approve", "reject", "change"];
const TERMINAL_LEVELS = ["Never", "A few times", "Monthly", "Weekly or more"];
const AGENT_LEVELS = ["Never", "Tried it", "Use it regularly"];
const PREFERENCES = ["The plain prompt", "The file preview", "No preference"];
const RATING_KEYS = ["affected", "confident", "easy", "toomuch"];
const SET_X = ["rm-tmp", "rm-drafts", "cp-config", "mv-invoices"];
const SET_Y = ["rm-logs", "cp-photos", "mv-rename", "mv-screenshots"];
const SCENARIO_MATCHES = {
  "rm-tmp": true,
  "rm-drafts": false,
  "rm-logs": false,
  "cp-config": true,
  "cp-photos": false,
  "mv-rename": true,
  "mv-invoices": false,
  "mv-screenshots": true,
};

function jsonOutput(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value, field, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    fail(`invalid ${field}`);
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) fail(`invalid ${field}`);
  return value;
}

function optionalText(value, field, maxLength) {
  if (value == null) return "";
  if (typeof value !== "string" || value.length > maxLength) fail(`invalid ${field}`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) fail(`invalid ${field}`);
  return value;
}

function oneOf(value, values, field) {
  if (!values.includes(value)) fail(`invalid ${field}`);
  return value;
}

function integerInRange(value, min, max, field) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`invalid ${field}`);
  return value;
}

function validateRatings(value, field) {
  if (!isObject(value)) fail(`invalid ${field}`);
  const result = {};
  RATING_KEYS.forEach((key) => {
    result[key] = integerInRange(value[key], 1, 5, `${field}.${key}`);
  });
  return result;
}

function expectedScenarioSet(group, condition) {
  const plainUsesX = group[0] === "A";
  const useX = condition === "baseline" ? plainUsesX : !plainUsesX;
  return useX ? SET_X : SET_Y;
}

function sameMembers(actual, expected) {
  if (actual.length !== expected.length) return false;
  const values = new Set(actual);
  return values.size === expected.length && expected.every((value) => values.has(value));
}

function validateBlocks(blocks, group) {
  if (!Array.isArray(blocks) || blocks.length !== 2) fail("invalid blocks");
  const expectedOrder = group[1] === "1"
    ? ["baseline", "structured"]
    : ["structured", "baseline"];
  blocks.forEach((block, index) => {
    if (!isObject(block) || block.condition !== expectedOrder[index] || !Array.isArray(block.scenarios)) {
      fail("invalid blocks");
    }
    const ids = block.scenarios.map((scenario) => isObject(scenario) ? scenario.id : "");
    if (!sameMembers(ids, expectedScenarioSet(group, block.condition))) fail("invalid blocks");
  });
}

function validatePayload(data, raw) {
  if (!isObject(data)) fail("invalid payload");
  const id = requiredText(data.id, "id", 128);
  if (!ID_RE.test(id)) fail("invalid id");

  const version = requiredText(data.version, "version", 100);
  const group = oneOf(data.group, GROUPS, "group");
  const payloadHarness = data.harness == null
    ? "legacy"
    : oneOf(data.harness, HARNESSES, "harness");

  const startedAt = requiredText(data.startedAt, "startedAt", 64);
  const finishedAt = requiredText(data.finishedAt, "finishedAt", 64);
  const startedMs = Date.parse(startedAt);
  const finishedMs = Date.parse(finishedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(finishedMs) || finishedMs < startedMs) {
    fail("invalid timestamps");
  }

  if (!isObject(data.background)) fail("invalid background");
  const background = {
    terminal: oneOf(data.background.terminal, TERMINAL_LEVELS, "background.terminal"),
    agents: oneOf(data.background.agents, AGENT_LEVELS, "background.agents"),
  };

  if (!isObject(data.ratings)) fail("invalid ratings");
  const ratings = {
    baseline: validateRatings(data.ratings.baseline, "ratings.baseline"),
    structured: validateRatings(data.ratings.structured, "ratings.structured"),
  };

  if (!isObject(data.final)) fail("invalid final");
  const final = {
    prefer: oneOf(data.final.prefer, PREFERENCES, "final.prefer"),
    why: optionalText(data.final.why, "final.why", MAX_TEXT_CHARS),
    missing: optionalText(data.final.missing, "final.missing", MAX_TEXT_CHARS),
  };

  validateBlocks(data.blocks, group);
  if (!Array.isArray(data.trials) || data.trials.length !== EXPECTED_TRIALS) {
    fail("invalid trials");
  }

  const expectedConditionOrder = group[1] === "1"
    ? ["baseline", "structured"]
    : ["structured", "baseline"];
  const seenScenarios = new Set();
  const trials = data.trials.map((trial, index) => {
    if (!isObject(trial)) fail("invalid trial");
    const condition = oneOf(trial.condition, CONDITIONS, `trials[${index}].condition`);
    if (condition !== expectedConditionOrder[Math.floor(index / 4)]) fail("invalid trial order");
    const scenario = oneOf(trial.scenario, Object.keys(SCENARIO_MATCHES), `trials[${index}].scenario`);
    if (!expectedScenarioSet(group, condition).includes(scenario) || seenScenarios.has(scenario)) {
      fail("invalid trial scenarios");
    }
    seenScenarios.add(scenario);

    const decision = oneOf(trial.decision, DECISIONS, `trials[${index}].decision`);
    if (typeof trial.correct !== "boolean") fail(`invalid trials[${index}].correct`);
    const expectedCorrect = (decision === "approve") === SCENARIO_MATCHES[scenario];
    if (trial.correct !== expectedCorrect) fail(`invalid trials[${index}].correct`);
    if (trial.practice === true) fail(`invalid trials[${index}].practice`);

    let harness = payloadHarness;
    if (trial.harness != null) {
      harness = oneOf(trial.harness, HARNESSES, `trials[${index}].harness`);
      if (payloadHarness !== "legacy" && harness !== payloadHarness) fail("trial harness mismatch");
    }

    return {
      scenario,
      condition,
      decision,
      correct: trial.correct,
      ms: integerInRange(trial.ms, 0, 86400000, `trials[${index}].ms`),
      confidence: integerInRange(trial.confidence, 1, 5, `trials[${index}].confidence`),
      comment: optionalText(trial.comment, `trials[${index}].comment`, MAX_TEXT_CHARS),
      harness,
    };
  });

  return {
    id,
    version,
    group,
    harness: payloadHarness,
    startedAt,
    finishedAt,
    background,
    ratings,
    final,
    trials,
    raw,
  };
}

// Google Sheets treats leading =, +, -, and @ as formulas. Prefix a literal
// apostrophe after any leading whitespace so arbitrary participant text stays data.
function safeCellText(value) {
  const text = String(value == null ? "" : value);
  return /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
}

function ensureSheet(name, columns) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let target = book.getSheetByName(name);
  if (!target) target = book.insertSheet(name);

  let headers = [];
  if (target.getLastRow() > 0 && target.getLastColumn() > 0) {
    headers = target.getRange(1, 1, 1, target.getLastColumn()).getValues()[0]
      .map((value) => String(value));
  }
  const duplicates = headers.filter((header, index) => header && headers.indexOf(header) !== index);
  if (duplicates.length) fail(`duplicate headers in ${name}`);

  if (!headers.length) {
    headers = columns.slice();
    target.getRange(1, 1, 1, headers.length).setValues([headers]);
    target.setFrozenRows(1);
  } else {
    const missing = columns.filter((column) => !headers.includes(column));
    if (missing.length) {
      target.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
      headers = headers.concat(missing);
    }
  }
  return { sheet: target, headers };
}

function readSheet(name) {
  const target = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!target || target.getLastRow() < 1 || target.getLastColumn() < 1) return null;
  const headers = target.getRange(1, 1, 1, target.getLastColumn()).getValues()[0]
    .map((value) => String(value));
  return { sheet: target, headers };
}

function dataRows(meta) {
  const count = meta.sheet.getLastRow() - 1;
  if (count <= 0) return [];
  return meta.sheet.getRange(2, 1, count, meta.headers.length).getValues();
}

function rowsForId(meta, id) {
  if (!meta) return [];
  const idColumn = meta.headers.indexOf("id");
  if (idColumn === -1) return [];
  return dataRows(meta).filter((row) => String(row[idColumn]) === id);
}

function trialOrdersForId(meta, id) {
  if (!meta) return new Set();
  const orderColumn = meta.headers.indexOf("order");
  if (orderColumn === -1) return new Set();
  return new Set(rowsForId(meta, id).map((row) => Number(row[orderColumn]))
    .filter((order) => Number.isInteger(order) && order >= 1 && order <= EXPECTED_TRIALS));
}

function receiptSaved(id, responseMeta, trialMeta) {
  const responses = rowsForId(responseMeta || readSheet("responses"), id);
  const orders = trialOrdersForId(trialMeta || readSheet("trials"), id);
  if (!responses.length) return false;
  for (let order = 1; order <= EXPECTED_TRIALS; order += 1) {
    if (!orders.has(order)) return false;
  }
  return true;
}

function rowForHeaders(headers, record) {
  return headers.map((header) => Object.prototype.hasOwnProperty.call(record, header)
    ? record[header]
    : "");
}

function appendRecords(meta, records) {
  if (!records.length) return;
  const rows = records.map((record) => rowForHeaders(meta.headers, record));
  meta.sheet.getRange(meta.sheet.getLastRow() + 1, 1, rows.length, meta.headers.length)
    .setValues(rows);
}

function responseRecord(data) {
  return {
    received: new Date(),
    id: safeCellText(data.id),
    version: safeCellText(data.version),
    group: data.group,
    started: safeCellText(data.startedAt),
    finished: safeCellText(data.finishedAt),
    terminal: data.background.terminal,
    agents: data.background.agents,
    plain_affected: data.ratings.baseline.affected,
    plain_confident: data.ratings.baseline.confident,
    plain_easy: data.ratings.baseline.easy,
    plain_toomuch: data.ratings.baseline.toomuch,
    preview_affected: data.ratings.structured.affected,
    preview_confident: data.ratings.structured.confident,
    preview_easy: data.ratings.structured.easy,
    preview_toomuch: data.ratings.structured.toomuch,
    prefer: data.final.prefer,
    why: safeCellText(data.final.why),
    missing: safeCellText(data.final.missing),
    raw_json: safeCellText(data.raw),
    harness: data.harness,
  };
}

function trialRecord(data, trial, index) {
  return {
    id: safeCellText(data.id),
    group: data.group,
    order: index + 1,
    scenario: trial.scenario,
    screen: trial.condition === "baseline" ? "plain" : "preview",
    decision: trial.decision,
    correct: trial.correct,
    ms: trial.ms,
    confidence: trial.confidence,
    comment: safeCellText(trial.comment),
    harness: trial.harness,
  };
}

function doPost(e) {
  let data;
  try {
    const raw = e && e.postData && typeof e.postData.contents === "string"
      ? e.postData.contents
      : "";
    if (!raw || raw.length > MAX_BODY_CHARS) fail("invalid body");
    data = validatePayload(JSON.parse(raw), raw);
  } catch (error) {
    return jsonOutput({ ok: false, saved: false, error: "invalid_payload" });
  }

  const lock = LockService.getScriptLock();
  let locked = false;
  try {
    lock.waitLock(10000);
    locked = true;

    const responseMeta = ensureSheet("responses", RESPONSE_COLUMNS);
    const trialMeta = ensureSheet("trials", TRIAL_COLUMNS);
    if (receiptSaved(data.id, responseMeta, trialMeta)) {
      return jsonOutput({ ok: true, saved: true, id: data.id, duplicate: true });
    }

    // Repair a prior partial attempt without duplicating already stored orders.
    const existingOrders = trialOrdersForId(trialMeta, data.id);
    const missingTrials = data.trials
      .map((trial, index) => ({ trial, index }))
      .filter(({ index }) => !existingOrders.has(index + 1))
      .map(({ trial, index }) => trialRecord(data, trial, index));
    appendRecords(trialMeta, missingTrials); // one setValues call for all missing trials

    if (!rowsForId(responseMeta, data.id).length) {
      // Write the response last; the public receipt cannot become true before
      // the complete trial batch is visible.
      appendRecords(responseMeta, [responseRecord(data)]);
    }

    if (!receiptSaved(data.id, responseMeta, trialMeta)) fail("incomplete write");
    return jsonOutput({ ok: true, saved: true, id: data.id, duplicate: false });
  } catch (error) {
    return jsonOutput({ ok: false, saved: false, id: data.id, error: "storage_error" });
  } finally {
    if (locked) lock.releaseLock();
  }
}

// Receipt protocol used after the browser's no-cors POST:
//   GET ?receipt=<unguessable participant id>
//   {"ok":true,"saved":true|false,"id":"<same id>"}
// It exposes no response data. Invalid or missing ids return ok:false.
function doGet(e) {
  const id = e && e.parameter && typeof e.parameter.receipt === "string"
    ? e.parameter.receipt
    : "";
  if (!ID_RE.test(id)) return jsonOutput({ ok: false, saved: false, id: "" });
  try {
    return jsonOutput({ ok: true, saved: receiptSaved(id), id });
  } catch (error) {
    return jsonOutput({ ok: false, saved: false, id });
  }
}
