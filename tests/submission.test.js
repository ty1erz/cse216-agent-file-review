const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function setup(fetch) {
  const values = new Map();
  const localStorage = {
    get length() { return values.size; }, key: (i) => [...values.keys()][i],
    getItem: (k) => values.get(k), setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k),
  };
  const context = { window: {}, fetch, URL, AbortController, localStorage,
    setTimeout: (fn, ms) => ms < 10000 ? (queueMicrotask(fn), 0) : 0, clearTimeout() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../prototype/submission.js"), "utf8"), context);
  return { api: context.window.SurveySubmission, values };
}
const response = { id: "test-participant-123456", trials: [{ scenario: "a" }] };
const endpoint = "https://example.test/exec";

test("only a matching storage receipt clears a response backup", async () => {
  const calls = [];
  const { api, values } = setup(async (url, options) => {
    calls.push({ url, options });
    if (options.method === "POST") return { type: "opaque", status: 0 };
    return { ok: true, json: async () => ({ ok: true, saved: true, id: response.id }) };
  });
  assert.equal(api.backup(response), true);
  assert.equal((await api.submit(response, endpoint)).saved, true);
  assert.equal(values.size, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.mode, "no-cors");
  assert.equal(new URL(calls[1].url).searchParams.get("receipt"), response.id);
});

for (const receipt of [{ ok: true, saved: false, id: response.id }, { ok: true, saved: true, id: "someone-else" }]) {
  test(`an unconfirmed or mismatched receipt retains the backup: ${JSON.stringify(receipt)}`, async () => {
    const { api, values } = setup(async (_, opts) => opts.method === "POST" ? {} : { ok: true, json: async () => receipt });
    api.backup(response);
    assert.equal((await api.submit(response, endpoint)).saved, false);
    assert.equal(values.size, 1);
  });
}

test("legacy text endpoint and HTTP errors cannot report success", async () => {
  for (const reply of [{ ok: true, json: async () => { throw Error("not JSON"); } }, { ok: false }]) {
    const { api } = setup(async (_, opts) => opts.method === "POST" ? {} : reply);
    api.backup(response);
    assert.equal((await api.submit(response, endpoint)).saved, false);
    assert.equal(api.pending().length, 1);
  }
});

test("network failure preserves recovery after reload", async () => {
  const { api, values } = setup(async () => { throw Error("offline"); });
  api.backup(response);
  assert.equal((await api.submit(response, endpoint)).saved, false);
  assert.equal(api.pending()[0].id, response.id);
  values.set("file-review-pending:broken", "bad json");
  values.set("unrelated", "{}");
  assert.equal(api.pending().length, 1);
});
