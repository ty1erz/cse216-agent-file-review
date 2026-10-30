// A completed POST is not a storage receipt. Keep a local backup until the
// collector confirms that the response and all trial rows were saved.
(function () {
  "use strict";
  const PREFIX = "file-review-pending:";

  function backup(response) {
    try { localStorage.setItem(PREFIX + response.id, JSON.stringify(response)); return true; }
    catch (_) { return false; }
  }

  function pending() {
    try {
      const responses = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(PREFIX)) {
          try { responses.push(JSON.parse(localStorage.getItem(key))); } catch (_) { /* ignore invalid backups */ }
        }
      }
      return responses.filter((s) => s && typeof s.id === "string" && Array.isArray(s.trials));
    } catch (_) { return []; }
  }

  async function request(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try { return await fetch(url, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timer); }
  }

  async function submit(response, url) {
    if (!url) return { saved: false };
    try {
      await request(url, {
        method: "POST", mode: "no-cors",
        headers: { "Content-Type": "text/plain" }, body: JSON.stringify(response),
      });
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
        try {
          const receiptUrl = new URL(url);
          receiptUrl.searchParams.set("receipt", response.id);
          const res = await request(receiptUrl.href, { cache: "no-store" });
          if (!res.ok) continue;
          const receipt = await res.json();
          if (receipt.ok === true && receipt.saved === true && receipt.id === response.id) {
            try { localStorage.removeItem(PREFIX + response.id); } catch (_) { /* backup can remain */ }
            return { saved: true };
          }
        } catch (_) { /* old deployments have no receipt endpoint */ }
      }
    } catch (_) { /* backup remains available after a network failure */ }
    return { saved: false };
  }
  window.SurveySubmission = { backup, pending, submit };
})();
