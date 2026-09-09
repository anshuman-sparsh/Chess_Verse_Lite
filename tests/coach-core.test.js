const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../static/js/coach-core.js");
const { parsedGame, analysis, payload, report } = require("./coach-fixtures.js");

test("coach payload is compact, hashed, and derived from trusted analysis", async () => {
  const built = await payload();
  assert.match(built.gameHash, /^[a-f0-9]{64}$/);
  assert.equal(built.game.mainlineSan.length, 4);
  assert.equal(built.moveSignals[3].classification, "blunder");
  assert.equal(built.criticalMoments.length, 1);
  assert.equal(built.criticalMoments[0].bestMove, "Nf6");
  assert.ok(Buffer.byteLength(JSON.stringify(built)) < core.MAX_REQUEST_BYTES);
});

test("payload excludes redundant full position arrays and PGN comments", async () => {
  const serialized = JSON.stringify(await payload());
  assert.doesNotMatch(serialized, /normalizedPgn|positions|comments|audio|debug/i);
});

test("payload validation rejects nonexistent or conflicting ply evidence", async () => {
  const built = await payload();
  built.criticalMoments[0].ply = 999;
  assert.throws(() => core.validatePayload(built), /ply/i);
});

test("payload validation preserves classification integrity", async () => {
  const built = await payload();
  built.criticalMoments[0].classification = "best";
  assert.throws(() => core.validatePayload(built), /conflicts/i);
});

test("report validation rejects nonexistent plies and changed engine facts", async () => {
  const built = await payload();
  const badPly = report();
  badPly.strengths[0].plies = [999];
  assert.throws(() => core.validateCoachReport(badPly, built), /nonexistent ply/i);

  const badClass = report();
  badClass.criticalMoments[0].classification = "mistake";
  assert.throws(() => core.validateCoachReport(badClass, built), /classification/i);

  const badMove = report();
  badMove.criticalMoments[0].preferredMove = "a6";
  assert.throws(() => core.validateCoachReport(badMove, built), /preferred move/i);
});

test("analysis version changes invalidate the cache key", async () => {
  const { cacheKey } = require("../static/js/coach-client.js");
  const built = await payload();
  assert.notEqual(cacheKey(built), cacheKey({ ...built, analysisVersion: built.analysisVersion + 1 }));
});

test("unsupported source classifications cannot enter a coach payload", async () => {
  const changed = structuredClone(analysis);
  changed.moves[0].classification = "amazing";
  await assert.rejects(core.buildCoachPayload(parsedGame, changed), /unsupported classification/i);
});
