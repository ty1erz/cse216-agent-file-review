const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class MockRange {
  constructor(sheet, row, column, numRows = 1, numColumns = 1) {
    this.sheet = sheet;
    this.row = row;
    this.column = column;
    this.numRows = numRows;
    this.numColumns = numColumns;
  }

  getValues() {
    return Array.from({ length: this.numRows }, (_, rowOffset) =>
      Array.from({ length: this.numColumns }, (_, columnOffset) =>
        this.sheet.valueAt(this.row + rowOffset, this.column + columnOffset)));
  }

  setValues(values) {
    assert.equal(values.length, this.numRows);
    values.forEach((row) => assert.equal(row.length, this.numColumns));
    this.sheet.setValuesCalls.push({
      row: this.row,
      column: this.column,
      numRows: this.numRows,
      numColumns: this.numColumns,
    });
    values.forEach((row, rowOffset) => row.forEach((value, columnOffset) => {
      this.sheet.setValueAt(this.row + rowOffset, this.column + columnOffset, value);
    }));
    return this;
  }
}

class MockSheet {
  constructor(name, rows = []) {
    this.name = name;
    this.rows = rows.map((row) => row.slice());
    this.frozenRows = 0;
    this.setValuesCalls = [];
  }

  getLastRow() {
    let last = this.rows.length;
    while (last && !this.rows[last - 1].some((value) => value !== "" && value != null)) last -= 1;
    return last;
  }

  getLastColumn() {
    return this.rows.reduce((max, row) => Math.max(max, row.length), 0);
  }

  getRange(row, column, numRows = 1, numColumns = 1) {
    return new MockRange(this, row, column, numRows, numColumns);
  }

  setFrozenRows(count) {
    this.frozenRows = count;
  }

  valueAt(row, column) {
    return (this.rows[row - 1] || [])[column - 1] ?? "";
  }

  setValueAt(row, column, value) {
    while (this.rows.length < row) this.rows.push([]);
    while (this.rows[row - 1].length < column) this.rows[row - 1].push("");
    this.rows[row - 1][column - 1] = value;
  }
}

class MockSpreadsheet {
  constructor(initial = {}) {
    this.sheets = new Map(Object.entries(initial).map(([name, rows]) => [name, new MockSheet(name, rows)]));
  }

  getSheetByName(name) {
    return this.sheets.get(name) || null;
  }

  insertSheet(name) {
    const sheet = new MockSheet(name);
    this.sheets.set(name, sheet);
    return sheet;
  }
}

function loadCollector(initialSheets = {}) {
  const spreadsheet = new MockSpreadsheet(initialSheets);
  const lock = {
    waitCount: 0,
    releaseCount: 0,
    waitLock() { this.waitCount += 1; },
    releaseLock() { this.releaseCount += 1; },
  };
  const sandbox = {
    console,
    Date,
    JSON,
    Math,
    Number,
    Object,
    Set,
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
    LockService: { getScriptLock: () => lock },
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput(text) {
        return {
          text,
          mimeType: "text/plain",
          setMimeType(mimeType) { this.mimeType = mimeType; return this; },
        };
      },
    },
  };
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(__dirname, "..", "survey", "collect_responses.gs"), "utf8");
  vm.runInContext(source, sandbox, { filename: "collect_responses.gs" });
  return { sandbox, spreadsheet, lock };
}

const SET_X = ["rm-tmp", "rm-drafts", "cp-config", "mv-invoices"];
const SET_Y = ["rm-logs", "cp-photos", "mv-rename", "mv-screenshots"];
const MATCHES = {
  "rm-tmp": true,
  "rm-drafts": false,
  "rm-logs": false,
  "cp-config": true,
  "cp-photos": false,
  "mv-rename": true,
  "mv-invoices": false,
  "mv-screenshots": true,
};

function scenarioStub(id) {
  return { id, request: `Request ${id}`, command: `echo ${id}` };
}

function validPayload(overrides = {}) {
  const harness = overrides.harness === undefined ? "openhands" : overrides.harness;
  const ordered = [
    ...SET_X.map((scenario) => ({ scenario, condition: "baseline" })),
    ...SET_Y.map((scenario) => ({ scenario, condition: "structured" })),
  ];
  const payload = {
    id: "11111111-1111-4111-8111-111111111111",
    version: "m2-integrated-2026-10-29",
    group: "A1",
    harness,
    startedAt: "2026-10-29T18:00:00.000Z",
    finishedAt: "2026-10-29T18:10:00.000Z",
    blocks: [
      { condition: "baseline", scenarios: SET_X.map(scenarioStub) },
      { condition: "structured", scenarios: SET_Y.map(scenarioStub) },
    ],
    background: { terminal: "Weekly or more", agents: "Use it regularly" },
    trials: ordered.map(({ scenario, condition }, index) => ({
      scenario,
      condition,
      harness,
      practice: false,
      decision: MATCHES[scenario] ? "approve" : "reject",
      correct: true,
      ms: 1000 + index,
      confidence: 4,
      comment: "",
    })),
    ratings: {
      baseline: { affected: 3, confident: 4, easy: 5, toomuch: 2 },
      structured: { affected: 5, confident: 5, easy: 4, toomuch: 2 },
    },
    final: { prefer: "The file preview", why: "Clearer", missing: "" },
  };
  return Object.assign(payload, overrides);
}

function post(sandbox, payload) {
  return sandbox.doPost({ postData: { contents: JSON.stringify(payload) } });
}

function body(output) {
  return JSON.parse(output.text);
}

function headerIndex(sheet, name) {
  return sheet.rows[0].indexOf(name);
}

test("valid submission writes one mapped response row and one batched trial range", () => {
  const { sandbox, spreadsheet, lock } = loadCollector();
  const result = body(post(sandbox, validPayload()));
  assert.deepEqual(result, {
    ok: true,
    saved: true,
    id: "11111111-1111-4111-8111-111111111111",
    duplicate: false,
  });

  const responses = spreadsheet.getSheetByName("responses");
  const trials = spreadsheet.getSheetByName("trials");
  assert.equal(responses.rows.length, 2);
  assert.equal(trials.rows.length, 9);
  assert.equal(responses.rows[1][headerIndex(responses, "harness")], "openhands");
  assert.equal(trials.rows[1][headerIndex(trials, "scenario")], "rm-tmp");
  assert.equal(trials.rows[8][headerIndex(trials, "scenario")], "mv-screenshots");
  assert.ok(trials.setValuesCalls.some((call) => call.numRows === 8), "trials use one batch write");
  assert.equal(lock.waitCount, 1);
  assert.equal(lock.releaseCount, 1);
});

test("duplicate participant id is acknowledged without duplicate rows", () => {
  const { sandbox, spreadsheet } = loadCollector();
  const payload = validPayload();
  assert.equal(body(post(sandbox, payload)).duplicate, false);
  const duplicate = body(post(sandbox, payload));
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.saved, true);
  assert.equal(spreadsheet.getSheetByName("responses").rows.length, 2);
  assert.equal(spreadsheet.getSheetByName("trials").rows.length, 9);
});

test("invalid or incomplete payloads do not create sheets", () => {
  const cases = [
    "{not json",
    JSON.stringify({}),
    JSON.stringify(validPayload({ trials: validPayload().trials.slice(0, 7) })),
    JSON.stringify(validPayload({
      ratings: { baseline: { affected: 3 }, structured: validPayload().ratings.structured },
    })),
  ];
  cases.forEach((contents) => {
    const { sandbox, spreadsheet } = loadCollector();
    const result = body(sandbox.doPost({ postData: { contents } }));
    assert.deepEqual(result, { ok: false, saved: false, error: "invalid_payload" });
    assert.equal(spreadsheet.sheets.size, 0);
  });
});

test("arbitrary participant text is stored literally, never as a Sheet formula", () => {
  const { sandbox, spreadsheet } = loadCollector();
  const payload = validPayload();
  payload.version = "=HYPERLINK(\"https://example.com\")";
  payload.final.why = "  +SUM(1,2)";
  payload.final.missing = "@IMPORTXML(\"https://example.com\")";
  payload.trials[0].comment = "-1+1";
  assert.equal(body(post(sandbox, payload)).saved, true);

  const responses = spreadsheet.getSheetByName("responses");
  const trials = spreadsheet.getSheetByName("trials");
  assert.match(responses.rows[1][headerIndex(responses, "version")], /^'/);
  assert.match(responses.rows[1][headerIndex(responses, "why")], /^'/);
  assert.match(responses.rows[1][headerIndex(responses, "missing")], /^'/);
  assert.match(trials.rows[1][headerIndex(trials, "comment")], /^'/);
});

test("old header order is preserved, missing harness columns are appended and mapped", () => {
  const responseHeaders = [
    "id", "received", "version", "group", "started", "finished", "terminal", "agents",
    "plain_affected", "plain_confident", "plain_easy", "plain_toomuch",
    "preview_affected", "preview_confident", "preview_easy", "preview_toomuch",
    "prefer", "why", "missing", "raw_json", "custom_note",
  ];
  const trialHeaders = [
    "scenario", "id", "group", "order", "screen", "decision", "correct", "ms", "confidence", "comment",
  ];
  const { sandbox, spreadsheet } = loadCollector({ responses: [responseHeaders], trials: [trialHeaders] });
  const result = body(post(sandbox, validPayload()));
  assert.equal(result.saved, true);

  const responses = spreadsheet.getSheetByName("responses");
  const trials = spreadsheet.getSheetByName("trials");
  assert.deepEqual(responses.rows[0].slice(0, responseHeaders.length), responseHeaders);
  assert.equal(responses.rows[0].at(-1), "harness");
  assert.equal(responses.rows[1][headerIndex(responses, "id")], "11111111-1111-4111-8111-111111111111");
  assert.equal(responses.rows[1][headerIndex(responses, "custom_note")], "");
  assert.equal(responses.rows[1][headerIndex(responses, "harness")], "openhands");
  assert.deepEqual(trials.rows[0].slice(0, trialHeaders.length), trialHeaders);
  assert.equal(trials.rows[0].at(-1), "harness");
  assert.equal(trials.rows[1][headerIndex(trials, "scenario")], "rm-tmp");
});

test("legacy payload without harness remains accepted as legacy", () => {
  const { sandbox, spreadsheet } = loadCollector();
  const payload = validPayload();
  delete payload.harness;
  payload.trials.forEach((trial) => delete trial.harness);
  const result = body(post(sandbox, payload));
  assert.equal(result.saved, true);
  const responses = spreadsheet.getSheetByName("responses");
  const trials = spreadsheet.getSheetByName("trials");
  assert.equal(responses.rows[1][headerIndex(responses, "harness")], "legacy");
  assert.equal(trials.rows[1][headerIndex(trials, "harness")], "legacy");
});

test("receipt endpoint returns only saved status and the validated receipt id", () => {
  const { sandbox } = loadCollector();
  assert.deepEqual(body(sandbox.doGet({ parameter: {} })), { ok: false, saved: false, id: "" });
  assert.deepEqual(body(sandbox.doGet({ parameter: { receipt: "too-short" } })), { ok: false, saved: false, id: "" });

  const id = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(body(sandbox.doGet({ parameter: { receipt: id } })), { ok: true, saved: false, id });
  post(sandbox, validPayload());
  assert.deepEqual(body(sandbox.doGet({ parameter: { receipt: id } })), { ok: true, saved: true, id });
});

test("retry repairs missing trial orders without duplicating the response row", () => {
  const { sandbox, spreadsheet } = loadCollector();
  const payload = validPayload();
  post(sandbox, payload);
  const trials = spreadsheet.getSheetByName("trials");
  trials.rows.splice(5, 1); // remove stored order 5 to simulate a partial write
  assert.equal(body(sandbox.doGet({ parameter: { receipt: payload.id } })).saved, false);

  const result = body(post(sandbox, payload));
  assert.equal(result.saved, true);
  assert.equal(result.duplicate, false);
  assert.equal(spreadsheet.getSheetByName("responses").rows.length, 2);
  assert.equal(trials.rows.length, 9);
  const orderIndex = headerIndex(trials, "order");
  assert.deepEqual(trials.rows.slice(1).map((row) => row[orderIndex]).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
});
