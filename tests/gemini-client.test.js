const test = require("node:test");
const assert = require("node:assert/strict");
const { callGemini, getGeminiConfig, DEFAULT_GEMINI_MODEL } = require("../lib/gemini-client.js");
const { payload, report } = require("./coach-fixtures.js");

test("model defaults centrally and swaps through configuration only", () => {
  assert.equal(getGeminiConfig({ GEMINI_API_KEY: "secret" }).model, DEFAULT_GEMINI_MODEL);
  assert.equal(getGeminiConfig({ GEMINI_API_KEY: "secret", GEMINI_MODEL: "gemini-3.7-flash" }).model, "gemini-3.7-flash");
});

test("Gemini adapter requests structured JSON with low thinking", async () => {
  const built = await payload();
  let captured;
  const result = await callGemini(built, {
    env: { GEMINI_API_KEY: "server-secret", GEMINI_MODEL: "gemini-3.8-flash" },
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return { ok: true, async json() { return { candidates: [{ content: { parts: [{ text: JSON.stringify(report()) }] } }] }; } };
    },
  });
  assert.match(captured.url, /gemini-3\.8-flash:generateContent$/);
  assert.equal(captured.options.headers["x-goog-api-key"], "server-secret");
  assert.equal(captured.body.generationConfig.thinkingConfig.thinkingLevel, "low");
  assert.equal(captured.body.generationConfig.responseMimeType, "application/json");
  assert.deepEqual(result.report, report());
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
