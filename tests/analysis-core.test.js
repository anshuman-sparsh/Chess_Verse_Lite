const test = require("node:test");
const assert = require("node:assert/strict");
const { Chess } = require("../static/js/chess.min.js");
const core = require("../static/js/analysis-core.js");

test("PGN parsing uses chess.js and precomputes each position", () => {
  const game = core.parsePgn("[White \"Ada\"]\n[Black \"Grace\"]\n\n1. e4 e5 2. Nf3 Nc6", Chess);
  assert.equal(game.headers.White, "Ada");
  assert.equal(game.moves.length, 4);
  assert.equal(game.positions.length, 5);
  assert.equal(game.moves[0].uci, "e2e4");
  assert.equal(game.moves[3].fenAfter, game.finalFen);
});

test("SetUp/FEN PGNs preserve the supplied starting position and promotion", () => {
  const pgn = `[SetUp "1"]
[FEN "8/P7/8/8/8/8/7p/4K2k w - - 0 1"]

1. a8=Q`;
  const game = core.parsePgn(pgn, Chess);
  assert.match(game.startFen, /^8\/P7\//);
  assert.equal(game.moves[0].san, "a8=Q+");
  assert.equal(game.moves[0].uci, "a7a8q");
});

test("castling and en passant are parsed by the same authoritative flow", () => {
  const castling = core.parsePgn("1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O", Chess);
  assert.equal(castling.moves.at(-1).san, "O-O");

  const enPassant = core.parsePgn("1. e4 a6 2. e5 d5 3. exd6", Chess);
  assert.equal(enPassant.moves.at(-1).san, "exd6");
});

test("empty, malformed, and oversized games fail without partial output", () => {
  assert.throws(() => core.parsePgn("", Chess), /paste a PGN/i);
  assert.throws(() => core.parsePgn("x".repeat(core.MAX_PGN_CHARACTERS + 1), Chess), /too large/i);
  assert.throws(() => core.parsePgn("1. e4 e5 2. Bh6", Chess), /Invalid PGN/i);
  assert.throws(() => core.parsePgn("1. e4 e5", Chess, 1), /too long/i);
});

test("tagged cp and mate scores retain White POV without sentinel values", () => {
  assert.equal(core.whiteWinProbability(core.cpScore(0)), 50);
  assert.equal(core.whiteWinProbability(core.cpScore(100000)), core.whiteWinProbability(core.cpScore(1000)));
  assert.equal(core.whiteWinProbability(core.mateScore("white", 3)), 100);
  assert.equal(core.whiteWinProbability(core.mateScore("black", 1)), 0);
  assert.equal(core.whiteWinProbability(core.drawScore()), 50);
});

test("win-probability loss is calculated from the mover's perspective", () => {
  const whiteLoss = core.probabilityLoss(core.cpScore(100), core.cpScore(-100), "white");
  const blackGain = core.probabilityLoss(core.cpScore(100), core.cpScore(-100), "black");
  assert.ok(whiteLoss.loss > 0);
  assert.equal(blackGain.loss, 0);
  assert.equal(whiteLoss.before, blackGain.after);
});

test("equal raw cp drops matter less in already-winning positions", () => {
  const balanced = core.probabilityLoss(core.cpScore(20), core.cpScore(-80), "white");
  const winning = core.probabilityLoss(core.cpScore(800), core.cpScore(700), "white");
  assert.ok(balanced.loss > winning.loss);
});

test("short-game accuracy averages available moves and represents no moves as null", () => {
  const oneMoveAccuracy = core.accuracyFromProbabilityLoss(2);
  assert.equal(core.averageOrNull([oneMoveAccuracy]), oneMoveAccuracy);
  assert.equal(core.averageOrNull([]), null);
});

test("classification thresholds, Miss, Book, Great, and Brilliant are conservative", () => {
  const base = { side: "white", playedUci: "e2e4", bestUci: "d2d4", beforeScore: core.cpScore(0), afterScore: core.cpScore(0), winProbabilityBefore: 50, winProbabilityAfter: 50 };
  assert.equal(core.classifyMove({ ...base, winProbabilityLoss: 0.4 }), "best");
  assert.equal(core.classifyMove({ ...base, winProbabilityLoss: 2 }), "good");
  assert.equal(core.classifyMove({ ...base, winProbabilityLoss: 9 }), "mistake");
  assert.equal(core.classifyMove({ ...base, winProbabilityLoss: 20 }), "blunder");
  assert.equal(core.classifyMove({ ...base, isBook: true, winProbabilityLoss: 30 }), "book");
  assert.equal(core.classifyMove({ ...base, winProbabilityBefore: 85, winProbabilityAfter: 45, winProbabilityLoss: 40 }), "miss");

  const nearBestSacrifice = { ...base, playedUci: "e2e4", bestUci: "e2e4", winProbabilityLoss: 0.2, materialSacrificeValue: 3 };
  assert.equal(core.classifyMove(nearBestSacrifice), "best");
  assert.equal(core.classifyMove({ ...nearBestSacrifice, sacrificePersists: true, tacticalJustification: true, uniqueGap: 6 }), "brilliant");
  assert.equal(core.classifyMove({ ...base, playedUci: "e2e4", bestUci: "e2e4", winProbabilityLoss: 0.5, nonObvious: true, uniqueGap: 6 }), "great");
});

test("losing a forced mate is classified as a Miss", () => {
  const result = core.classifyMove({
    side: "black",
    playedUci: "a7a6",
    bestUci: "h7h5",
    beforeScore: core.mateScore("black", 2),
    afterScore: core.cpScore(0),
    winProbabilityBefore: 100,
    winProbabilityAfter: 50,
    winProbabilityLoss: 50,
  });
  assert.equal(result, "miss");
});
