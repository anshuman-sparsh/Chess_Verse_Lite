const coachCore = require("../static/js/coach-core.js");

const startFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const parsedGame = {
  headers: { White: "Ada", Black: "Grace", Result: "1-0" },
  startFen,
  moves: ["e4", "e5", "Qh5", "Nc6"].map((san, index) => ({ san, fenAfter: startFen, ply: index + 1 })),
};

const analysis = {
  schema_version: 2,
  white_accuracy_percent: 82,
  black_accuracy_percent: 61,
  moves: [
    move(1, "e4", "white", "e2e4", "best", 0, "e4", ["e4", "e5"]),
    move(2, "e5", "black", "e7e5", "excellent", 1, "e5", ["e5", "Nf3"]),
    move(3, "Qh5", "white", "d1h5", "good", 2.5, "Nf3", ["Nf3", "Nc6"]),
    move(4, "Nc6", "black", "b8c6", "blunder", 24, "Nf6", ["Nf6", "Qxe5+"])
  ],
};

function move(ply, san, side, uci, classification, loss, bestMove, pv) {
  return {
    ply, san, side, uci, classification,
    fen_before: startFen,
    fen_after: startFen,
    evaluation_before: { type: "cp", whitePovCp: ply * 10 },
    evaluation_after: { type: "cp", whitePovCp: ply === 4 ? 350 : ply * 12 },
    win_probability_before: 50 + ply,
    win_probability_after: Math.max(0, 50 + ply - loss),
    win_probability_loss: loss,
    best_move: bestMove,
    pv,
  };
}

async function payload() {
  return coachCore.buildCoachPayload(parsedGame, analysis);
}

function report() {
  return {
    overallReview: { text: "White gained the decisive advantage after Black's fourth ply." },
    strengths: [{ text: "White kept the early position stable." }],
    areasToImprove: [{ text: "Black should reduce large tactical losses." }],
    criticalMoments: [{
      title: "Decisive fourth ply",
      whatChanged: "Black's winning probability fell sharply.",
      whyItMattered: "This produced the game's largest engine-measured loss.",
    }],
    trainingRecommendations: [{ text: "Practice checking forcing replies before developing a piece." }],
    phaseAssessment: null,
    oneLineTakeaway: { text: "Check your opponent's forcing threats before each developing move." },
  };
}

module.exports = { parsedGame, analysis, payload, report };
