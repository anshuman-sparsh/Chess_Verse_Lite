(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ChessVerseCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_GAME_PLIES = 400;
  const MAX_PGN_CHARACTERS = 100000;
  const CP_CLAMP = 1000;
  const WIN_PROBABILITY_COEFFICIENT = 0.00368208;
  const ACCURACY_DECAY = 0.035;

  function normalizePgn(pgn) {
    const clean = String(pgn || "").replace(/^\uFEFF/, "").trim();
    const lastTagIndex = clean.lastIndexOf("]");
    if (lastTagIndex < 0) return clean;
    const headers = clean.slice(0, lastTagIndex + 1);
    const moves = clean.slice(lastTagIndex + 1).trim();
    return moves ? `${headers}\n\n${moves}` : clean;
  }

  function parsePgn(pgn, ChessCtor, maxPlies = MAX_GAME_PLIES) {
    if (typeof ChessCtor !== "function") throw new Error("chess.js is not available.");
    const normalizedInput = normalizePgn(pgn);
    if (!normalizedInput) throw new Error("Please paste a PGN game first.");
    if (normalizedInput.length > MAX_PGN_CHARACTERS) {
      throw new Error(`PGN is too large. Maximum supported size is ${MAX_PGN_CHARACTERS.toLocaleString()} characters.`);
    }

    const parsed = new ChessCtor();
    if (!parsed.load_pgn(normalizedInput)) throw new Error("Invalid PGN game.");

    const headers = parsed.header ? parsed.header() : {};
    const history = parsed.history({ verbose: true });
    if (!history.length) throw new Error("Could not find any moves in that PGN.");
    if (history.length > maxPlies) {
      throw new Error(`Game is too long (${history.length} plies). Maximum supported length is ${maxPlies}.`);
    }

    const standardFen = new ChessCtor().fen();
    const startFen = headers.SetUp === "1" && headers.FEN ? headers.FEN : standardFen;
    const replay = new ChessCtor(startFen);
    const positions = [replay.fen()];
    const moves = [];

    history.forEach((move, index) => {
      const applied = replay.move({
        from: move.from,
        to: move.to,
        promotion: move.promotion,
      });
      if (!applied) throw new Error(`PGN contains an illegal move at ply ${index + 1}.`);
      const fenAfter = replay.fen();
      moves.push({
        ply: index + 1,
        san: applied.san,
        uci: applied.from + applied.to + (applied.promotion || ""),
        color: applied.color,
        fenBefore: positions[index],
        fenAfter,
      });
      positions.push(fenAfter);
    });

    return {
      input: normalizedInput,
      normalizedPgn: parsed.pgn ? parsed.pgn() : normalizedInput,
      headers,
      startFen,
      finalFen: positions[positions.length - 1],
      moves,
      positions,
    };
  }

  function cpScore(whitePovCp) {
    return { type: "cp", whitePovCp: Number(whitePovCp) || 0 };
  }

  function mateScore(winner, moves) {
    return { type: "mate", winner, moves: Math.max(0, Math.abs(Number(moves) || 0)) };
  }

  function drawScore() {
    return { type: "terminal", result: "draw" };
  }

  function scoreToWhitePovPawns(score) {
    if (!score) return 0;
    if (score.type === "cp") return score.whitePovCp / 100;
    if (score.type === "mate") return score.winner === "white" ? CP_CLAMP / 100 : -CP_CLAMP / 100;
    return 0;
  }

  function whiteWinProbability(score) {
    if (!score) return 50;
    if (score.type === "mate") return score.winner === "white" ? 100 : 0;
    if (score.type === "terminal") return 50;
    const cp = Math.max(-CP_CLAMP, Math.min(CP_CLAMP, Number(score.whitePovCp) || 0));
    return 100 / (1 + Math.exp(-WIN_PROBABILITY_COEFFICIENT * cp));
  }

  function moverWinProbability(score, side) {
    const whiteProbability = whiteWinProbability(score);
    return side === "white" || side === "w" ? whiteProbability : 100 - whiteProbability;
  }

  function probabilityLoss(beforeScore, afterScore, side) {
    const before = moverWinProbability(beforeScore, side);
    const after = moverWinProbability(afterScore, side);
    return {
      before,
      after,
      loss: Math.max(0, Math.min(100, before - after)),
    };
  }

  function accuracyFromProbabilityLoss(loss) {
    const safeLoss = Math.max(0, Math.min(100, Number(loss) || 0));
    return Math.max(0, Math.min(100, 100 * Math.exp(-ACCURACY_DECAY * safeLoss)));
  }

  function sameMove(a, b) {
    return Boolean(a && b && String(a).toLowerCase() === String(b).toLowerCase());
  }

  function moverHasMate(score, side) {
    if (!score || score.type !== "mate") return false;
    return (side === "white" || side === "w") ? score.winner === "white" : score.winner === "black";
  }

  function isMissedOpportunity(data) {
    if (sameMove(data.playedUci, data.bestUci)) return false;
    const before = Number(data.winProbabilityBefore);
    const after = Number(data.winProbabilityAfter);
    const loss = Number(data.winProbabilityLoss);
    if (moverHasMate(data.beforeScore, data.side) && !moverHasMate(data.afterScore, data.side)) return true;
    return before >= 70 && after <= 55 && loss >= 15;
  }

  function hasBrilliantEvidence(data) {
    return Boolean(
      data.materialSacrificeValue >= 1 &&
      data.sacrificePersists === true &&
      data.tacticalJustification === true &&
      data.isForced !== true &&
      data.uniqueGap >= 5 &&
      data.winProbabilityLoss <= 0.5 &&
      sameMove(data.playedUci, data.bestUci)
    );
  }

  function hasGreatEvidence(data) {
    return Boolean(
      data.nonObvious === true &&
      data.isForced !== true &&
      data.uniqueGap >= 5 &&
      data.winProbabilityLoss <= 1 &&
      sameMove(data.playedUci, data.bestUci)
    );
  }

  function classifyMove(data) {
    if (data.isBook === true) return "book";
    if (hasBrilliantEvidence(data)) return "brilliant";
    if (hasGreatEvidence(data)) return "great";
    if (isMissedOpportunity(data)) return "miss";

    const loss = Math.max(0, Number(data.winProbabilityLoss) || 0);
    if (sameMove(data.playedUci, data.bestUci) || loss <= 0.5) return "best";
    if (loss <= 1.5) return "excellent";
    if (loss <= 3) return "good";
    if (loss <= 7) return "inaccuracy";
    if (loss <= 15) return "mistake";
    return "blunder";
  }

  function averageOrNull(values) {
    const finite = values.filter(Number.isFinite);
    if (!finite.length) return null;
    return finite.reduce((sum, value) => sum + value, 0) / finite.length;
  }

  return {
    MAX_GAME_PLIES,
    MAX_PGN_CHARACTERS,
    CP_CLAMP,
    WIN_PROBABILITY_COEFFICIENT,
    ACCURACY_DECAY,
    normalizePgn,
    parsePgn,
    cpScore,
    mateScore,
    drawScore,
    scoreToWhitePovPawns,
    whiteWinProbability,
    moverWinProbability,
    probabilityLoss,
    accuracyFromProbabilityLoss,
    isMissedOpportunity,
    hasBrilliantEvidence,
    hasGreatEvidence,
    classifyMove,
    averageOrNull,
  };
});
