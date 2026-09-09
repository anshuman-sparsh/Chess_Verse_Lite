const test = require("node:test");
const assert = require("node:assert/strict");
const { CoachRequestManager, createMemoryCache, cacheKey, renderReport } = require("../static/js/coach-client.js");
const core = require("../static/js/coach-core.js");
const { payload, report } = require("./coach-fixtures.js");

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

test("rendered preferred move comes from trusted Stockfish analysis", async () => {
  class Node {
    constructor() { this.children = []; this.textContent = ""; this.className = ""; }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
  }
  const previousDocument = global.document;
  global.document = { createElement: () => new Node() };
  try {
    const built = await payload();
    const prose = report();
    prose.criticalMoments[0].preferredMove = "g8f6";
    const trusted = core.validateCoachReport(prose, built);
    const root = new Node();
    renderReport(root, trusted);
    const flatten = (node) => [node, ...node.children.flatMap(flatten)];
    assert.ok(flatten(root).some((node) => node.textContent === "Stockfish preferred: Nf6"));
    assert.ok(!flatten(root).some((node) => node.textContent.includes("g8f6")));
  } finally {
    global.document = previousDocument;
  }
});

test("concurrent Generate actions share one request", async () => {
  const built = await payload();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const manager = new CoachRequestManager({
    cache: createMemoryCache(),
    fetchImpl: async () => {
      calls += 1;
      await gate;
      return jsonResponse({ ok: true, gameHash: built.gameHash, schemaVersion: built.schemaVersion, analysisVersion: 2, report: report() });
    },
  });
  const first = manager.generate(built);
  const second = manager.generate(built);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(a.report, b.report);
});

test("a cached report prevents duplicate API usage", async () => {
  const built = await payload();
  const cache = createMemoryCache();
  await cache.set(cacheKey(built), report());
  const manager = new CoachRequestManager({ cache, fetchImpl: async () => { throw new Error("must not call"); } });
  const result = await manager.generate(built);
  assert.equal(result.cached, true);
});

test("invalid cached data is discarded", async () => {
  const built = await payload();
  const cache = createMemoryCache();
  await cache.set(cacheKey(built), { nope: true });
  let calls = 0;
  const manager = new CoachRequestManager({
    cache,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ ok: true, gameHash: built.gameHash, schemaVersion: built.schemaVersion, analysisVersion: 2, report: report() });
    },
  });
  await manager.generate(built);
  assert.equal(calls, 1);
});

test("client surfaces safe API failures", async () => {
  const built = await payload();
  const manager = new CoachRequestManager({
    cache: createMemoryCache(),
    fetchImpl: async () => jsonResponse({ ok: false, error: { code: "rate_limited", message: "Please wait." } }, 429),
  });
  await assert.rejects(manager.generate(built), /Please wait/);
});
