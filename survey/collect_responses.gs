// Google Apps Script that stores survey responses in the Sheet it's attached to.
// Setup steps are in README.md ("Collecting responses").
//
// Each finished survey adds:
//   - one row to "responses": participant info, ratings, preference, raw JSON
//   - one row per scenario to "trials": decision, correctness, time, confidence

const RESPONSE_COLUMNS = [
  "received", "id", "version", "group", "started", "finished",
  "terminal", "agents",
  "plain_affected", "plain_confident", "plain_easy", "plain_toomuch",
  "preview_affected", "preview_confident", "preview_easy", "preview_toomuch",
  "prefer", "why", "missing", "raw_json",
];
const TRIAL_COLUMNS = [
  "id", "group", "order", "scenario", "screen", "decision", "correct",
  "ms", "confidence", "comment",
];

function sheet(name, columns) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let s = book.getSheetByName(name);
  if (!s) {
    s = book.insertSheet(name);
    s.appendRow(columns);
    s.setFrozenRows(1);
  }
  return s;
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const d = JSON.parse(e.postData.contents);
    const plain = (d.ratings && d.ratings.baseline) || {};
    const rich = (d.ratings && d.ratings.structured) || {};
    const bg = d.background || {};
    const fin = d.final || {};

    sheet("responses", RESPONSE_COLUMNS).appendRow([
      new Date(), d.id, d.version, d.group, d.startedAt, d.finishedAt,
      bg.terminal, bg.agents,
      plain.affected, plain.confident, plain.easy, plain.toomuch,
      rich.affected, rich.confident, rich.easy, rich.toomuch,
      fin.prefer, fin.why || "", fin.missing || "", e.postData.contents,
    ]);

    const trials = sheet("trials", TRIAL_COLUMNS);
    (d.trials || []).forEach((t, i) => {
      trials.appendRow([
        d.id, d.group, i + 1, t.scenario,
        t.condition === "baseline" ? "plain" : "preview",
        t.decision, t.correct, t.ms, t.confidence, t.comment || "",
      ]);
    });
    return ContentService.createTextOutput("ok");
  } finally {
    lock.releaseLock();
  }
}

// Visiting the web app URL in a browser shows this, which confirms it's deployed.
// It reports only how many responses have arrived, nothing about them.
function doGet() {
  const s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("responses");
  const n = s ? s.getLastRow() - 1 : 0;
  return ContentService.createTextOutput(`Survey collector is running. ${n} responses so far.`);
}
