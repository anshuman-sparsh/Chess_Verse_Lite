const test = require("node:test");
const assert = require("node:assert/strict");
const { createCoachHandler } = require("../api/coach.js");
const { ProviderError } = require("../lib/gemini-client.js");
const { payload, report } = require("./coach-fixtures.js");

function invoke(handler, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = { "content-type": "application/json", ...(options.headers || {}) };
    const req = {
      method: options.method || "POST",
      headers,
      body: options.body,
      socket: { remoteAddress: "127.0.0.1" },
    };
    const responseHeaders = {};
    const res = {
      statusCode: 200,
      setHeader(name, value) { responseHeaders[name.toLowerCase()] = value; },
      end(value) {
        try { resolve({ status: this.statusCode, headers: responseHeaders, body: JSON.parse(value) }); }
        catch (error) { reject(error); }
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

function handlerWith(provider) {
  return createCoachHandler({ provider, rateLimit: () => true, env: { GEMINI_API_KEY: "test" }, logger: { error() {} } });
}

test("endpoint accepts POST only and enforces request size", async () => {
  const handler = handlerWith(async () => ({ report: report(), model: "test" }));
  assert.equal((await invoke(handler, { method: "GET" })).status, 405);
  const tooLarge = await invoke(handler, { body: {}, headers: { "content-length": String(70 * 1024) } });
  assert.equal(tooLarge.status, 413);
});

test("endpoint rejects malformed JSON and invalid payloads with 400", async () => {
  const handler = handlerWith(async () => ({ report: report(), model: "test" }));
  assert.equal((await invoke(handler, { body: "{" })).status, 400);
  assert.equal((await invoke(handler, { body: { schemaVersion: 1 } })).status, 400);
});

test("endpoint verifies the canonical game hash", async () => {
  const built = await payload();
  built.gameHash = "0".repeat(64);
  const response = await invoke(handlerWith(async () => ({ report: report(), model: "test" })), { body: built });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "invalid_payload");
});

test("endpoint validates and returns a compact mocked report", async () => {
  const built = await payload();
  const response = await invoke(handlerWith(async () => ({ report: report(), model: "gemini-test" })), { body: built });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.gameHash, built.gameHash);
  assert.equal(response.body.report.criticalMoments[0].classification, "blunder");
  assert.equal(response.headers["cache-control"], "no-store");
});

test("endpoint ignores Gemini attempts to echo or alter immutable engine facts", async () => {
  const built = await payload();
  const prose = report();
  Object.assign(prose.criticalMoments[0], { preferredMove: "g8f6", ply: 999, classification: "best" });
  const response = await invoke(handlerWith(async () => ({ report: prose, model: "test" })), { body: built });
  assert.equal(response.status, 200);
  assert.equal(response.body.report.criticalMoments[0].preferredMove, "Nf6");
  assert.equal(response.body.report.criticalMoments[0].ply, 4);
  assert.equal(response.body.report.criticalMoments[0].classification, "blunder");
});

test("provider 400/401/403/429/500 and timeout errors map to safe responses", async (t) => {
  const built = await payload();
  for (const [providerStatus, expected] of [[400, 503], [401, 503], [403, 503], [429, 429], [500, 502]]) {
    await t.test(`provider ${providerStatus}`, async () => {
      const handler = handlerWith(async () => { throw new ProviderError("provider_http", "raw provider detail", providerStatus); });
      const response = await invoke(handler, { body: built });
      assert.equal(response.status, expected);
      assert.doesNotMatch(JSON.stringify(response.body), /raw provider detail/);
    });
  }
  await t.test("provider timeout", async () => {
    const handler = handlerWith(async () => { throw new ProviderError("timeout", "internal timeout", 504); });
    const response = await invoke(handler, { body: built });
    assert.equal(response.status, 504);
    assert.equal(response.body.error.code, "provider_timeout");
  });
});

test("best-effort endpoint rate limiting returns 429 with Retry-After", async () => {
  const built = await payload();
  const handler = createCoachHandler({
    provider: async () => ({ report: report(), model: "test" }),
    rateLimit: () => false,
    env: { GEMINI_API_KEY: "test" },
  });
  const response = await invoke(handler, { body: built });
  assert.equal(response.status, 429);
  assert.equal(response.headers["retry-after"], "60");
});
