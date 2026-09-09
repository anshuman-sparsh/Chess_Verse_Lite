const test = require("node:test");
const assert = require("node:assert/strict");
const { callGemini, getGeminiConfig, DEFAULT_GEMINI_MODEL, DEFAULT_GEMINI_FALLBACK_MODEL } = require("../lib/gemini-client.js");
const { payload, report } = require("./coach-fixtures.js");

test("model defaults centrally and swaps through configuration only", () => {
  assert.equal(DEFAULT_GEMINI_MODEL, "gemini-3.7-flash");
  assert.equal(DEFAULT_GEMINI_FALLBACK_MODEL, "gemini-3.5-flash-lite");
  assert.equal(getGeminiConfig({ GEMINI_API_KEY: "secret" }).model, DEFAULT_GEMINI_MODEL);
  assert.equal(getGeminiConfig({ GEMINI_API_KEY: "secret", GEMINI_MODEL: "gemini-3.7-flash" }).model, "gemini-3.7-flash");
  assert.equal(getGeminiConfig({ GEMINI_API_KEY: "secret", GEMINI_FALLBACK_MODEL: "gemini-custom-lite" }).fallbackModel, "gemini-custom-lite");
});

test("Gemini adapter requests structured JSON with low thinking", async () => {
  const built = await payload();
  let captured;
  const result = await callGemini(built, {
    env: { GEMINI_API_KEY: "server-secret", GEMINI_MODEL: "gemini-3.7-flash" },
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return { ok: true, async json() { return { candidates: [{ content: { parts: [{ text: JSON.stringify(report()) }] } }] }; } };
    },
  });
  assert.match(captured.url, /gemini-3\.7-flash:generateContent$/);
  assert.equal(captured.options.headers["x-goog-api-key"], "server-secret");
  assert.equal(captured.body.generationConfig.thinkingConfig.thinkingLevel, "low");
  assert.equal(captured.body.generationConfig.responseMimeType, "application/json");
  assert.deepEqual(result.report, report());
});

function unavailable() {
  return { ok: false, status: 503, async text() { return "UNAVAILABLE"; } };
}

function success() {
  return { ok: true, status: 200, async json() { return { candidates: [{ content: { parts: [{ text: JSON.stringify(report()) }] } }] }; } };
}

test("primary 503 retries once with the same model and succeeds", async () => {
  const urls = [];
  const bodies = [];
  const result = await callGemini(await payload(), {
    env: { GEMINI_API_KEY: "secret" }, sleep: async () => {}, random: () => 0,
    fetchImpl: async (url, options) => { urls.push(url); bodies.push(options.body); return urls.length === 1 ? unavailable() : success(); },
  });
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => url.includes("gemini-3.7-flash")));
  assert.equal(bodies[0], bodies[1]);
  assert.equal(result.model, "gemini-3.7-flash");
});

test("two primary 503 responses fall back and succeed", async () => {
  const urls = [];
  const result = await callGemini(await payload(), {
    env: { GEMINI_API_KEY: "secret" }, sleep: async () => {},
    fetchImpl: async (url) => { urls.push(url); return urls.length < 3 ? unavailable() : success(); },
  });
  assert.equal(urls.length, 3);
  assert.match(urls[2], /gemini-3\.5-flash-lite/);
  assert.equal(result.fallbackUsed, true);
});

test("persistent overload rejects as provider 503", async () => {
  let calls = 0;
  await assert.rejects(callGemini(await payload(), {
    env: { GEMINI_API_KEY: "secret" }, sleep: async () => {},
    fetchImpl: async () => { calls += 1; return unavailable(); },
  }), (error) => error.status === 503);
  assert.equal(calls, 3);
});

test("400, 401, and 403 do not retry or fall back", async (t) => {
  for (const status of [400, 401, 403]) await t.test(String(status), async () => {
    let calls = 0;
    await assert.rejects(callGemini(await payload(), {
      env: { GEMINI_API_KEY: "secret" }, sleep: async () => {},
      fetchImpl: async () => ({ ok: false, status, async text() { calls += 1; return "failure"; } }),
    }), (error) => error.status === status);
    assert.equal(calls, 1);
  });
});

test("malformed Gemini report JSON is rejected", async () => {
  await assert.rejects(callGemini(await payload(), {
    env: { GEMINI_API_KEY: "server-secret" },
    fetchImpl: async () => ({ ok: true, async json() { return { candidates: [{ content: { parts: [{ text: "{" }] } }] }; } }),
  }), (error) => error.code === "malformed_response");
});

test("provider timeout aborts without a live API call", async () => {
  await assert.rejects(callGemini(await payload(), {
    env: { GEMINI_API_KEY: "server-secret" },
    timeoutMs: 5,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }),
  }), (error) => error.code === "timeout");
});
