(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ChessVerseCoachCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const COACH_SCHEMA_VERSION = 1;
  const ANALYSIS_SCHEMA_VERSION = 2;
  const MAX_PLIES = 400;
  const MAX_CRITICAL_MOMENTS = 8;
  const MAX_PV_MOVES = 5;
  const MAX_REQUEST_BYTES = 64 * 1024;
  const MAX_RESPONSE_BYTES = 32 * 1024;
  const CLASSIFICATIONS = Object.freeze([
    "book", "brilliant", "great", "best", "excellent", "good",
    "inaccuracy", "mistake", "miss", "blunder",
  ]);
  const CLASSIFICATION_SET = new Set(CLASSIFICATIONS);
  const ADVERSE_PRIORITY = { miss: 5, blunder: 4, mistake: 3, inaccuracy: 2 };

  function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  function cleanString(value, maxLength, fallback = "") {
    if (typeof value !== "string") return fallback;
    return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, maxLength);
  }

  function finiteNumber(value, min, max, fallback = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
  }

  function round(value, digits = 2) {
    const factor = 10 ** digits;
    return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
  }

  function normalizeScore(score) {
    if (!isRecord(score)) return { type: "terminal", result: "draw" };
    if (score.type === "cp") {
      return { type: "cp", whitePovCp: Math.round(finiteNumber(score.whitePovCp, -100000, 100000)) };
    }
    if (score.type === "mate") {
      return {
        type: "mate",
        winner: score.winner === "black" ? "black" : "white",
        moves: Math.round(finiteNumber(score.moves, 0, 999)),
      };
    }
    return { type: "terminal", result: "draw" };
  }

  function phaseFromFen(fen, ply) {
    if (ply <= 16) return "opening";
    const placement = cleanString(fen, 100).split(" ")[0];
    let nonPawnMaterial = 0;
    for (const piece of placement) {
      if (piece.toLowerCase() === "q") nonPawnMaterial += 9;
      else if (piece.toLowerCase() === "r") nonPawnMaterial += 5;
      else if (piece.toLowerCase() === "b" || piece.toLowerCase() === "n") nonPawnMaterial += 3;
    }
    return nonPawnMaterial <= 14 ? "endgame" : "middlegame";
  }

  function canonicalGame(game) {
    return {
      white: cleanString(game?.white, 80, "White"),
      black: cleanString(game?.black, 80, "Black"),
      result: cleanString(game?.result, 16, "*"),
      startFen: cleanString(game?.startFen, 120),
      mainlineSan: Array.isArray(game?.mainlineSan)
        ? game.mainlineSan.slice(0, MAX_PLIES).map((san) => cleanString(san, 32))
        : [],
    };
  }

  function canonicalGameString(game) {
    return JSON.stringify(canonicalGame(game));
  }

  async function sha256Hex(text, cryptoImpl) {
    const cryptoApi = cryptoImpl || globalThis.crypto;
    if (!cryptoApi?.subtle) throw new Error("Secure hashing is unavailable in this browser.");
    const bytes = new TextEncoder().encode(text);
    const digest = await cryptoApi.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function computeGameHash(game, cryptoImpl) {
    return sha256Hex(canonicalGameString(game), cryptoImpl);
  }

  function classificationCounts(signals) {
    const counts = { white: {}, black: {} };
    for (const cls of CLASSIFICATIONS) {
      counts.white[cls] = 0;
      counts.black[cls] = 0;
    }
    for (const signal of signals) counts[signal.side][signal.classification] += 1;
    return counts;
  }

  function buildPhaseMetrics(signals) {
    const groups = new Map();
    for (const signal of signals) {
      const key = `${signal.side}:${signal.phase}`;
      const group = groups.get(key) || { side: signal.side, phase: signal.phase, plies: 0, totalLoss: 0, adverseMoves: 0 };
      group.plies += 1;
      group.totalLoss += signal.winProbabilityLoss;
      if (["inaccuracy", "mistake", "miss", "blunder"].includes(signal.classification)) group.adverseMoves += 1;
      groups.set(key, group);
    }
    return Array.from(groups.values())
      .filter((group) => group.plies >= 2)
      .map((group) => ({
        side: group.side,
        phase: group.phase,
        plies: group.plies,
        averageWinProbabilityLoss: round(group.totalLoss / group.plies),
        adverseMoves: group.adverseMoves,
      }));
  }

  function selectCriticalMoments(analysisMoves, signals) {
    const candidates = analysisMoves.map((move, index) => ({ move, signal: signals[index] }))
      .filter(({ signal }) => ADVERSE_PRIORITY[signal.classification] || signal.winProbabilityLoss >= 3)
      .sort((a, b) => {
        const priority = (ADVERSE_PRIORITY[b.signal.classification] || 0) - (ADVERSE_PRIORITY[a.signal.classification] || 0);
        return priority || b.signal.winProbabilityLoss - a.signal.winProbabilityLoss || a.signal.ply - b.signal.ply;
      });

    return candidates.slice(0, MAX_CRITICAL_MOMENTS).map(({ move, signal }) => ({
      ply: signal.ply,
      moveNumber: signal.moveNumber,
      side: signal.side,
      san: signal.san,
      uci: cleanString(move.uci, 8),
      phase: signal.phase,
      fenBefore: cleanString(move.fen_before, 120),
      evaluationBefore: normalizeScore(move.evaluation_before),
      evaluationAfter: normalizeScore(move.evaluation_after),
      winProbabilityBefore: round(finiteNumber(move.win_probability_before, 0, 100)),
      winProbabilityAfter: round(finiteNumber(move.win_probability_after, 0, 100)),
      winProbabilityLoss: signal.winProbabilityLoss,
      classification: signal.classification,
      bestMove: move.best_move ? cleanString(move.best_move, 32) : null,
      principalVariation: Array.isArray(move.pv)
        ? move.pv.slice(0, MAX_PV_MOVES).map((san) => cleanString(san, 32))
        : [],
    }));
  }

  async function buildCoachPayload(parsedGame, analysis, options = {}) {
    if (!parsedGame || !analysis || !Array.isArray(analysis.moves) || !analysis.moves.length) {
      throw new Error("A completed Stockfish analysis is required.");
    }
    if (analysis.schema_version !== ANALYSIS_SCHEMA_VERSION) throw new Error("Unsupported analysis version.");
    if (analysis.moves.length > MAX_PLIES) throw new Error("Analysis exceeds the 400-ply limit.");

    const headers = parsedGame.headers || {};
    const game = canonicalGame({
      white: headers.White || "White",
      black: headers.Black || "Black",
      result: headers.Result || "*",
      startFen: parsedGame.startFen,
      mainlineSan: parsedGame.moves.map((move) => move.san),
    });

    const signals = analysis.moves.map((move, index) => {
      const classification = cleanString(move.classification, 20).toLowerCase();
      if (!CLASSIFICATION_SET.has(classification)) throw new Error(`Unsupported classification at ply ${index + 1}.`);
      return {
        ply: index + 1,
        moveNumber: Math.ceil((index + 1) / 2),
        side: move.side === "black" ? "black" : "white",
        san: cleanString(move.san, 32),
        phase: phaseFromFen(move.fen_after, index + 1),
        classification,
        winProbabilityLoss: round(finiteNumber(move.win_probability_loss, 0, 100)),
      };
    });

    const payload = {
      schemaVersion: COACH_SCHEMA_VERSION,
      analysisVersion: ANALYSIS_SCHEMA_VERSION,
      gameHash: await computeGameHash(game, options.crypto),
      game,
      summary: {
        whiteAccuracy: analysis.white_accuracy_percent == null ? null : round(finiteNumber(analysis.white_accuracy_percent, 0, 100)),
        blackAccuracy: analysis.black_accuracy_percent == null ? null : round(finiteNumber(analysis.black_accuracy_percent, 0, 100)),
        classificationCounts: classificationCounts(signals),
        phaseMetrics: buildPhaseMetrics(signals),
      },
      moveSignals: signals,
      criticalMoments: selectCriticalMoments(analysis.moves, signals),
    };
    if (new TextEncoder().encode(JSON.stringify(payload)).length > MAX_REQUEST_BYTES) {
      throw new Error("Prepared AI Coach data is too large.");
    }
    return payload;
  }

  function validationError(message) {
    const error = new Error(message);
    error.name = "ValidationError";
    return error;
  }

  function validatePayload(payload) {
    if (!isRecord(payload)) throw validationError("Request body must be an object.");
    if (payload.schemaVersion !== COACH_SCHEMA_VERSION || payload.analysisVersion !== ANALYSIS_SCHEMA_VERSION) {
      throw validationError("Unsupported AI Coach schema version.");
    }
    if (!/^[a-f0-9]{64}$/.test(payload.gameHash || "")) throw validationError("Invalid game hash.");
    const game = canonicalGame(payload.game);
    if (!game.startFen || !game.mainlineSan.length || game.mainlineSan.length > MAX_PLIES) throw validationError("Invalid game data.");
    if (!Array.isArray(payload.moveSignals) || payload.moveSignals.length !== game.mainlineSan.length) {
      throw validationError("Move signals do not match the game mainline.");
    }

    const signals = payload.moveSignals.map((raw, index) => {
      if (!isRecord(raw) || raw.ply !== index + 1 || raw.san !== game.mainlineSan[index]) {
        throw validationError(`Invalid move signal at ply ${index + 1}.`);
      }
      const classification = cleanString(raw.classification, 20).toLowerCase();
      if (!CLASSIFICATION_SET.has(classification)) throw validationError(`Invalid classification at ply ${index + 1}.`);
      if (!['white', 'black'].includes(raw.side) || !['opening', 'middlegame', 'endgame'].includes(raw.phase)) {
        throw validationError(`Invalid move metadata at ply ${index + 1}.`);
      }
      return {
        ply: index + 1,
        moveNumber: Math.ceil((index + 1) / 2),
        side: raw.side,
        san: game.mainlineSan[index],
        phase: raw.phase,
        classification,
        winProbabilityLoss: round(finiteNumber(raw.winProbabilityLoss, 0, 100)),
      };
    });

    if (!Array.isArray(payload.criticalMoments) || payload.criticalMoments.length > MAX_CRITICAL_MOMENTS) {
      throw validationError("Invalid critical moments.");
    }
    const seen = new Set();
    const criticalMoments = payload.criticalMoments.map((raw) => {
      if (!isRecord(raw) || !Number.isInteger(raw.ply) || raw.ply < 1 || raw.ply > signals.length || seen.has(raw.ply)) {
        throw validationError("Invalid critical-moment ply reference.");
      }
      seen.add(raw.ply);
      const signal = signals[raw.ply - 1];
      if (raw.san !== signal.san || raw.classification !== signal.classification || raw.side !== signal.side) {
        throw validationError(`Critical-moment evidence conflicts at ply ${raw.ply}.`);
      }
      if (Math.abs(Number(raw.winProbabilityLoss) - signal.winProbabilityLoss) > 0.011) {
        throw validationError(`Critical-moment loss conflicts at ply ${raw.ply}.`);
      }
      return {
        ply: raw.ply,
        moveNumber: signal.moveNumber,
        side: signal.side,
        san: signal.san,
        uci: cleanString(raw.uci, 8),
        phase: signal.phase,
        fenBefore: cleanString(raw.fenBefore, 120),
        evaluationBefore: normalizeScore(raw.evaluationBefore),
        evaluationAfter: normalizeScore(raw.evaluationAfter),
        winProbabilityBefore: round(finiteNumber(raw.winProbabilityBefore, 0, 100)),
        winProbabilityAfter: round(finiteNumber(raw.winProbabilityAfter, 0, 100)),
        winProbabilityLoss: signal.winProbabilityLoss,
        classification: signal.classification,
        bestMove: raw.bestMove == null ? null : cleanString(raw.bestMove, 32),
        principalVariation: Array.isArray(raw.principalVariation)
          ? raw.principalVariation.slice(0, MAX_PV_MOVES).map((move) => cleanString(move, 32))
          : [],
      };
    });

    const summary = isRecord(payload.summary) ? payload.summary : {};
    return {
      schemaVersion: COACH_SCHEMA_VERSION,
      analysisVersion: ANALYSIS_SCHEMA_VERSION,
      gameHash: payload.gameHash,
      game,
      summary: {
        whiteAccuracy: summary.whiteAccuracy == null ? null : round(finiteNumber(summary.whiteAccuracy, 0, 100)),
        blackAccuracy: summary.blackAccuracy == null ? null : round(finiteNumber(summary.blackAccuracy, 0, 100)),
        classificationCounts: classificationCounts(signals),
        phaseMetrics: buildPhaseMetrics(signals),
      },
      moveSignals: signals,
      criticalMoments,
    };
  }

  function textItem(value, basis, allowedPlies, maxLength = 500) {
    if (!isRecord(value) || value.basis !== basis) throw validationError("Invalid report evidence basis.");
    const text = cleanString(value.text, maxLength);
    if (!text) throw validationError("Report text is required.");
    const plies = Array.isArray(value.plies) ? [...new Set(value.plies)] : [];
    if (!plies.length) throw validationError("Report evidence must reference at least one ply.");
    if (plies.some((ply) => !Number.isInteger(ply) || !allowedPlies.has(ply))) {
      throw validationError("Report references a nonexistent ply.");
    }
    return { text, basis, plies };
  }

  function validateCoachReport(report, payload) {
    if (!isRecord(report)) throw validationError("Gemini returned an invalid report object.");
    const allowedPlies = new Set(payload.moveSignals.map((move) => move.ply));
    const criticalByPly = new Map(payload.criticalMoments.map((moment) => [moment.ply, moment]));
    const mapItems = (items, basis, maxItems) => {
      if (!Array.isArray(items) || items.length > maxItems) throw validationError("Invalid report list.");
      return items.map((item) => textItem(item, basis, allowedPlies));
    };

    if (!Array.isArray(report.criticalMoments) || report.criticalMoments.length > MAX_CRITICAL_MOMENTS) {
      throw validationError("Invalid report critical moments.");
    }
    const criticalMoments = report.criticalMoments.map((item) => {
      if (!isRecord(item) || !Number.isInteger(item.ply) || !criticalByPly.has(item.ply)) {
        throw validationError("Report references an unsupported critical moment.");
      }
      const evidence = criticalByPly.get(item.ply);
      if (item.basis !== "engine") throw validationError("Invalid critical-moment evidence basis.");
      if (item.classification !== evidence.classification) throw validationError("Report changed an engine classification.");
      const preferredMove = item.preferredMove == null ? null : cleanString(item.preferredMove, 32);
      if (preferredMove !== evidence.bestMove) throw validationError("Report changed the engine preferred move.");
      const title = cleanString(item.title, 100);
      const whatChanged = cleanString(item.whatChanged, 500);
      const whyItMattered = cleanString(item.whyItMattered, 500);
      if (!title || !whatChanged || !whyItMattered) throw validationError("Critical-moment text is required.");
      return {
        ply: item.ply,
        classification: evidence.classification,
        title,
        whatChanged,
        whyItMattered,
        preferredMove,
        basis: "engine",
      };
    });

    let phaseAssessment = null;
    if (report.phaseAssessment !== null) {
      if (!Array.isArray(report.phaseAssessment) || report.phaseAssessment.length > 5) throw validationError("Invalid phase assessment.");
      const supported = new Set(payload.summary.phaseMetrics.filter((metric) => metric.plies >= 2).map((metric) => `${metric.side}:${metric.phase}`));
      phaseAssessment = report.phaseAssessment.map((item) => {
        if (!isRecord(item) || !supported.has(`${item.side}:${item.phase}`)) throw validationError("Unsupported phase assessment.");
        if (!['strong', 'solid', 'mixed', 'needs-work'].includes(item.rating)) throw validationError("Invalid phase rating.");
        const evidence = textItem({ text: item.text, basis: item.basis, plies: item.plies }, "engine", allowedPlies, 400);
        if (evidence.plies.length < 2 || evidence.plies.some((ply) => {
          const move = payload.moveSignals[ply - 1];
          return move.side !== item.side || move.phase !== item.phase;
        })) throw validationError("Phase evidence does not support the assessment.");
        return { side: item.side, phase: item.phase, rating: item.rating, ...evidence };
      });
    }

    const validated = {
      overallReview: textItem(report.overallReview, "engine", allowedPlies, 700),
      strengths: mapItems(report.strengths, "engine", 5),
      areasToImprove: mapItems(report.areasToImprove, "engine", 5),
      criticalMoments,
      trainingRecommendations: mapItems(report.trainingRecommendations, "general_coaching_advice", 5),
      phaseAssessment,
      oneLineTakeaway: textItem(report.oneLineTakeaway, "general_coaching_advice", allowedPlies, 240),
    };
    if (new TextEncoder().encode(JSON.stringify(validated)).length > MAX_RESPONSE_BYTES) throw validationError("AI Coach report is too large.");
    return validated;
  }

  const REPORT_JSON_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["overallReview", "strengths", "areasToImprove", "criticalMoments", "trainingRecommendations", "phaseAssessment", "oneLineTakeaway"],
    properties: {
      overallReview: evidenceSchema("engine"),
      strengths: { type: "array", maxItems: 5, items: evidenceSchema("engine") },
      areasToImprove: { type: "array", maxItems: 5, items: evidenceSchema("engine") },
      criticalMoments: {
        type: "array", maxItems: MAX_CRITICAL_MOMENTS,
        items: {
          type: "object", additionalProperties: false,
          required: ["ply", "classification", "title", "whatChanged", "whyItMattered", "preferredMove", "basis"],
          properties: {
            ply: { type: "integer" }, classification: { type: "string", enum: CLASSIFICATIONS },
            title: { type: "string" }, whatChanged: { type: "string" }, whyItMattered: { type: "string" },
            preferredMove: { anyOf: [{ type: "string" }, { type: "null" }] }, basis: { type: "string", enum: ["engine"] },
          },
        },
      },
      trainingRecommendations: { type: "array", maxItems: 5, items: evidenceSchema("general_coaching_advice") },
      phaseAssessment: {
        anyOf: [
          { type: "null" },
          { type: "array", maxItems: 5, items: {
            type: "object", additionalProperties: false,
            required: ["side", "phase", "rating", "text", "basis", "plies"],
            properties: {
              side: { type: "string", enum: ["white", "black"] },
              phase: { type: "string", enum: ["opening", "middlegame", "endgame"] },
              rating: { type: "string", enum: ["strong", "solid", "mixed", "needs-work"] },
              text: { type: "string" }, basis: { type: "string", enum: ["engine"] },
              plies: { type: "array", minItems: 2, items: { type: "integer" } },
            },
          } },
        ],
      },
      oneLineTakeaway: evidenceSchema("general_coaching_advice"),
    },
  };

  function evidenceSchema(basis) {
    return {
      type: "object", additionalProperties: false, required: ["text", "basis", "plies"],
      properties: {
        text: { type: "string" }, basis: { type: "string", enum: [basis] },
        plies: { type: "array", minItems: 1, items: { type: "integer" } },
      },
    };
  }

  return {
    COACH_SCHEMA_VERSION, ANALYSIS_SCHEMA_VERSION, MAX_PLIES, MAX_CRITICAL_MOMENTS,
    MAX_PV_MOVES, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, CLASSIFICATIONS,
    canonicalGame, canonicalGameString, computeGameHash, buildCoachPayload,
    validatePayload, validateCoachReport, REPORT_JSON_SCHEMA, phaseFromFen,
  };
});
