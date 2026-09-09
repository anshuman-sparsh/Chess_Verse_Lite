const test = require("node:test");
const assert = require("node:assert/strict");
const { CoachRequestManager, createMemoryCache, cacheKey, renderReport, criticalMoveReference } = require("../static/js/coach-client.js");
const core = require("../static/js/coach-core.js");
const { payload, report } = require("./coach-fixtures.js");

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

class FakeNode {
  constructor() { this.children = []; this.textContent = ""; this.className = ""; }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
}

function renderedNodes(reportData) {
  const previousDocument = global.document;
  global.document = { createElement: () => new FakeNode() };
  try {
    const root = new FakeNode();
    renderReport(root, reportData);
    const flatten = (node) => [node, ...node.children.flatMap(flatten)];
    return flatten(root);
  } finally {
    global.document = previousDocument;
  }
}

test("rendered preferred move comes from trusted Stockfish analysis", async () => {
  const built = await payload();
  const prose = report();
  prose.criticalMoments[0].preferredMove = "g8f6";
  const nodes = renderedNodes(core.validateCoachReport(prose, built));
  assert.ok(nodes.some((node) => node.textContent === "Stockfish preferred"));
  assert.ok(nodes.some((node) => node.textContent === "Nf6"));
  assert.ok(!nodes.some((node) => node.textContent.includes("g8f6")));
});

test("AI Coach UI hides ply terminology while trusted identifiers remain", async () => {
  const built = await payload();
  const trusted = core.validateCoachReport(report(), built);
  assert.equal(trusted.criticalMoments[0].ply, 4);
  assert.ok(trusted.overallReview.plies.length > 0);
  const visible = renderedNodes(trusted).map((node) => node.textContent).join(" ");
  assert.doesNotMatch(visible, /\bply|\bplies/i);
  assert.doesNotMatch(visible, /Engine evidence:/i);
});

test("critical moments use SAN and correct White/Black move-number formatting", () => {
  assert.equal(criticalMoveReference({ ply: 14, side: "black", san: "Nc6" }), "7...Nc6");
  assert.equal(criticalMoveReference({ ply: 15, side: "white", san: "Be2" }), "8.Be2");
  assert.equal(criticalMoveReference({ ply: 14, side: "black" }), "Move 7...");
  assert.equal(criticalMoveReference({ ply: 15, side: "white" }), "Move 8.");
});

test("cached validated reports retain trusted moves and render without ply terminology", async () => {
  const built = await payload();
  const trusted = core.validateCoachReport(report(), built);
  const cache = createMemoryCache();
  await cache.set(cacheKey(built), trusted);
  const manager = new CoachRequestManager({ cache, fetchImpl: async () => { throw new Error("must not call"); } });
  const result = await manager.generate(built);
  assert.equal(result.cached, true);
  const visible = renderedNodes(result.report).map((node) => node.textContent).join(" ");
  assert.match(visible, /2\.\.\.Nc6/);
  assert.doesNotMatch(visible, /\bply|\bplies/i);
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
