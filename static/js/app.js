const core = window.ChessVerseCore;
const engine = new window.ChessVerseEngine.BrowserStockfish({
  ChessCtor: window.Chess,
  workerPaths: ["static/js/stockfish.wasm.js", "static/js/stockfish.js"],
});

function getPvSan(fen, pvUcis, maxLength = 5) {
  if (!pvUcis || pvUcis.length === 0) return [];
  try {
    const tempBoard = new window.Chess(fen);
    const sanList = [];
    for (let i = 0; i < Math.min(pvUcis.length, maxLength); i++) {
      const uci = pvUcis[i];
      const from = uci.slice(0, 2);
      const to = uci.slice(2, 4);
      const promotion = uci.length > 4 ? uci.slice(4, 5).toLowerCase() : undefined;
      
      const result = tempBoard.move({ from, to, promotion });
      if (result) {
        sanList.push(result.san);
      } else {
        break;
      }
    }
    return sanList;
  } catch (e) {
    console.error("PV conversion failed:", e);
    return [];
  }
}

async function analyzeGameMainline(parsedGame, progressCallback, sessionId) {
  const mainlineMoves = parsedGame.moves;
  let state = await engine.analyzePosition(parsedGame.startFen, 14, { sessionId });
  const moveRows = [];
  for (let ply = 1; ply <= mainlineMoves.length; ply += 1) {
    if (!engine.isCurrentSession(sessionId)) throw window.ChessVerseEngine.abortError();
    const moveObj = mainlineMoves[ply - 1];
    const sideLabel = moveObj.color === "w" ? "white" : "black";
    if (progressCallback) {
      progressCallback(ply, mainlineMoves.length);
    }

    const beforeState = state;
    const pvSan = getPvSan(moveObj.fenBefore, beforeState.pvUci, 5);
    const bestMove = pvSan[0] || beforeState.bestMoveUci;
    state = await engine.analyzePosition(moveObj.fenAfter, 14, { sessionId });
    const probabilities = core.probabilityLoss(beforeState.score, state.score, sideLabel);
    const accuracy = core.accuracyFromProbabilityLoss(probabilities.loss);
    const classification = core.classifyMove({
      side: sideLabel,
      playedUci: moveObj.uci,
      bestUci: beforeState.bestMoveUci,
      beforeScore: beforeState.score,
      afterScore: state.score,
      winProbabilityBefore: probabilities.before,
      winProbabilityAfter: probabilities.after,
      winProbabilityLoss: probabilities.loss,
      isBook: false,
    });

    moveRows.push({
      ply,
      san: moveObj.san,
      side: sideLabel,
      uci: moveObj.uci,
      fen_before: moveObj.fenBefore,
      fen_after: moveObj.fenAfter,
      evaluation_before: beforeState.score,
      evaluation_after: state.score,
      win_probability_before: Number(probabilities.before.toFixed(2)),
      win_probability_after: Number(probabilities.after.toFixed(2)),
      win_probability_loss: Number(probabilities.loss.toFixed(2)),
      accuracy: Number(accuracy.toFixed(2)),
      classification,
      best_move: bestMove,
      best_move_uci: beforeState.bestMoveUci,
      pv: pvSan,
    });
  }

  const whiteScores = [];
  const blackScores = [];
  for (const r of moveRows) {
    if (r.side === "white") whiteScores.push(r.accuracy);
    else blackScores.push(r.accuracy);
  }

  const allScores = whiteScores.concat(blackScores);
  const roundedAverage = (values) => {
    const average = core.averageOrNull(values);
    return average == null ? null : Number(average.toFixed(2));
  };
  return {
    schema_version: 2,
    engine: "bundled stockfish.js",
    limit: { depth: 14 },
    moves: moveRows,
    accuracy_percent: roundedAverage(allScores),
    white_accuracy_percent: roundedAverage(whiteScores),
    black_accuracy_percent: roundedAverage(blackScores),
  };
}

function setStatus(text, kind) {
  const el = document.getElementById("appStatus");
  const safeText = text || "";

  if (el) {
    el.textContent = safeText;
    if (kind === "error") el.style.color = "var(--danger)";
    else el.style.color = "var(--muted)";
  }
}

function setLoading(isLoading, message) {
  const el = document.getElementById("loadingIndicator");
  const cancelBtn = document.getElementById("cancelAnalysisBtn");
  if (!el) return;

  if (isLoading) {
    el.textContent = message || "Analyzing...";
    el.classList.remove("hidden");
    el.setAttribute("aria-hidden", "false");
    cancelBtn?.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
    el.setAttribute("aria-hidden", "true");
    cancelBtn?.classList.add("hidden");
  }
}

function formatPercent(value) {
  if (value === undefined || value === null || Number.isNaN(value)) return "--%";
  return `${value}%`;
}

const CLASSIFICATION_LABELS = {
  brilliant: "Brilliant",
  great: "Great",
  best: "Best",
  excellent: "Excellent",
  good: "Good",
  inaccuracy: "Inaccuracy",
  mistake: "Mistake",
  blunder: "Blunder",
  miss: "Miss",
  book: "Book",
};

function classificationLabel(cls) {
  const v = (cls || "").toString().toLowerCase();
  if (CLASSIFICATION_LABELS[v]) return CLASSIFICATION_LABELS[v];
  return v ? v.charAt(0).toUpperCase() + v.slice(1) : "—";
}

document.addEventListener("DOMContentLoaded", () => {
  const boardEl = document.getElementById("board");
  const pgnInput = document.getElementById("pgnInput");
  const analyzeBtn = document.getElementById("analyzeBtn");
  const resetBtn = document.getElementById("resetBtn");

  // Tabs UI Elements
  const tabMovesBtn = document.getElementById("tabMovesBtn");
  const tabInfoBtn = document.getElementById("tabInfoBtn");
  const tabCoachBtn = document.getElementById("tabCoachBtn");
  const tabContentMoves = document.getElementById("tabContentMoves");
  const tabContentInfo = document.getElementById("tabContentInfo");
  const tabContentCoach = document.getElementById("tabContentCoach");
  const infoEmptyState = document.getElementById("infoEmptyState");
  const tabDefinitions = [
    { name: "moves", button: tabMovesBtn, panel: tabContentMoves },
    { name: "info", button: tabInfoBtn, panel: tabContentInfo },
    { name: "coach", button: tabCoachBtn, panel: tabContentCoach },
  ];

  function showTab(tab) {
    for (const definition of tabDefinitions) {
      const active = definition.name === tab;
      definition.button?.classList.toggle("active", active);
      definition.button?.setAttribute("aria-selected", String(active));
      definition.button?.setAttribute("tabindex", active ? "0" : "-1");
      if (active) definition.panel?.removeAttribute("hidden");
      else definition.panel?.setAttribute("hidden", "true");
    }
  }

  tabMovesBtn?.addEventListener("click", () => showTab("moves"));
  tabInfoBtn?.addEventListener("click", () => showTab("info"));
  tabCoachBtn?.addEventListener("click", () => showTab("coach"));
  tabDefinitions.map((definition) => definition.button).filter(Boolean).forEach((tab, index, tabs) => {
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const next = tabs[(index + direction + tabs.length) % tabs.length];
      next.focus();
      next.click();
    });
  });

  let chessboard = null;
  let chess = null;

  // Mode state: 'review' or 'practice'
  let currentMode = "review";
  let practiceStartFen = null;
  let practiceFens = [];
  let practiceCurrentIndex = 0;
  let selectedSquare = null;
  let lastMousedownSquare = null;
  let lastMousedownTime = 0;
  let lastTouchTime = 0;

  // Move navigation state (mainline only).
  let moves = [];
  let moveUcis = [];
  let positionFens = [];
  let startingFen = null;
  let currentMoveIndex = 0; // number of moves applied from the start position
  let currentFen = null;
  let operationId = 0;

  // Board orientation state for syncing player name UI.
  // By default chessboard.js starts unflipped:
  // - Top (playerBlack) = Black
  // - Bottom (playerWhite) = White
  let isFlipped = false;

  // Player names extracted from PGN.
  let whiteName = "White";
  let blackName = "Black";

  /** Full `analysis.moves` from last successful analyze (for current-move panel). */
  let cachedAnalysisMoves = [];

  /** PGN text from last successful load (for Result / Termination overlay). */
  let loadedGameHeaders = {};

  function cancelCurrentAnalysis(reason = "Analysis canceled.") {
    operationId += 1;
    engine.startSession(reason);
    analyzeBtn.disabled = false;
    setLoading(false);
  }

  // ─── Feature 8: Sound Effects ───
  let soundEnabled = true;
  const soundCache = {};
  const SOUND_FILES = {
    move: "/static/sounds/move.wav",
    capture: "/static/sounds/capture.wav",
    check: "/static/sounds/check.wav",
    castle: "/static/sounds/castle.wav",
    "game-over": "/static/sounds/game-over.wav",
    promote: "/static/sounds/promote.wav",
  };

  function preloadSounds() {
    for (const [name, src] of Object.entries(SOUND_FILES)) {
      try {
        const audio = new Audio(src);
        audio.preload = "auto";
        audio.volume = 0.5;
        soundCache[name] = audio;
      } catch (e) { /* silent */ }
    }
  }
  preloadSounds();

  function playSound(name) {
    if (!soundEnabled) return;
    try {
      const audio = soundCache[name];
      if (audio) {
        audio.currentTime = 0;
        audio.play().catch(() => {});
      }
    } catch (e) { /* silent */ }
  }

  function detectMoveSound(san) {
    if (!san) return "move";
    if (san === "O-O" || san === "O-O-O") return "castle";
    if (san.includes("=")) return "promote";
    if (san.includes("x")) return "capture";
    if (san.includes("+") || san.includes("#")) return "check";
    return "move";
  }

  // ─── Feature 5: Board Annotations ───
  const ANNO_CLASSES = [
    "square-anno-played", "square-anno-best", "square-anno-blunder",
    "square-anno-mistake", "square-anno-miss", "square-anno-inaccuracy",
    "square-anno-brilliant", "square-anno-great"
  ];

  function clearBoardAnnotations() {
    const boardDiv = document.getElementById("board");
    if (!boardDiv) return;
    for (const cls of ANNO_CLASSES) {
      boardDiv.querySelectorAll("." + cls).forEach(el => el.classList.remove(cls));
    }
  }

  function annotateSquare(square, cssClass) {
    const boardDiv = document.getElementById("board");
    if (!boardDiv) return;
    const el = boardDiv.querySelector(`[data-square="${square}"]`);
    if (el) el.classList.add(cssClass);
  }

  function classificationToAnnoClass(cls) {
    const v = (cls || "").toLowerCase();
    if (v === "blunder") return "square-anno-blunder";
    if (v === "mistake") return "square-anno-mistake";
    if (v === "miss") return "square-anno-miss";
    if (v === "inaccuracy") return "square-anno-inaccuracy";
    if (v === "brilliant") return "square-anno-brilliant";
    if (v === "great") return "square-anno-great";
    if (v === "best" || v === "excellent" || v === "good") return "square-anno-best";
    return "square-anno-played";
  }

  function applyBoardAnnotations() {
    clearBoardAnnotations();
    if (currentMode === "practice") return;
    if (!cachedAnalysisMoves || cachedAnalysisMoves.length === 0) return;
    if (currentMoveIndex <= 0) return;

    const move = cachedAnalysisMoves[currentMoveIndex - 1];
    if (!move || !move.uci) return;

    const uci = move.uci;
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const cls = move.classification;
    const annoClass = classificationToAnnoClass(cls);

    annotateSquare(from, annoClass);
    annotateSquare(to, annoClass);

    // Show best move target square in green if different
    if (move.best_move && move.pv && move.pv.length > 0) {
      const isSuboptimal = ["inaccuracy", "mistake", "blunder", "miss"].includes(
        cls ? cls.toLowerCase() : ""
      );
      if (isSuboptimal) {
        // Try to extract the best move destination by parsing the best_move SAN
        // We need to use chess.js to figure out the from/to squares
        // Since chess is at the current position state after the move was played,
        // we need a temporary board at the position *before* the move
        try {
          const tempChess = new window.Chess(move.fen_before);
          const bestMoveObj = tempChess.move(move.best_move, { sloppy: true });
          if (bestMoveObj) {
            annotateSquare(bestMoveObj.to, "square-anno-best");
          }
        } catch (e) { /* silent */ }
      }
    }
  }

  // ─── Feature 7: Stats Breakdown ───
  const STATS_ORDER = [
    "brilliant", "great", "best", "excellent", "good",
    "book", "inaccuracy", "mistake", "miss", "blunder"
  ];

  const STATS_DOT_COLORS = {
    brilliant: "#13a2a6",
    great: "#ffc947",
    best: "#5ee4a0",
    excellent: "#5ee4a0",
    good: "#9cf5d8",
    book: "#c8d0ec",
    inaccuracy: "#fff59d",
    mistake: "#fbc02d",
    miss: "#ff8a80",
    blunder: "#b71c1c",
  };

  function renderStatsBreakdown() {
    const container = document.getElementById("statsBreakdown");
    const tbody = document.getElementById("statsTableBody");
    if (!container || !tbody) return;

    if (!cachedAnalysisMoves || cachedAnalysisMoves.length === 0) {
      container.hidden = true;
      if (infoEmptyState) infoEmptyState.hidden = false;
      return;
    }

    const whiteCounts = {};
    const blackCounts = {};
    for (const cls of STATS_ORDER) {
      whiteCounts[cls] = 0;
      blackCounts[cls] = 0;
    }

    for (const m of cachedAnalysisMoves) {
      const cls = (m.classification || "").toLowerCase();
      if (m.side === "white" && cls in whiteCounts) whiteCounts[cls]++;
      else if (m.side === "black" && cls in blackCounts) blackCounts[cls]++;
    }

    let html = "";
    for (const cls of STATS_ORDER) {
      const wc = whiteCounts[cls];
      const bc = blackCounts[cls];
      const dotColor = STATS_DOT_COLORS[cls] || "#888";
      const label = CLASSIFICATION_LABELS[cls] || cls;
      const wcClass = wc === 0 ? "stats-count-zero" : "";
      const bcClass = bc === 0 ? "stats-count-zero" : "";

      let dotHtml = "";
      if (cls === "brilliant") {
        dotHtml = `<span class="stats-cls-dot stats-cls-brilliant"></span>`;
      } else {
        dotHtml = `<span class="stats-cls-dot" style="background:${dotColor};box-shadow:0 0 4px ${dotColor}"></span>`;
      }

      html += `
        <tr>
          <td>
            <div class="stats-cls-cell">
              ${dotHtml}
              <span class="stats-cls-label" style="color:${dotColor}">${label}</span>
            </div>
          </td>
          <td class="stats-count-cell ${wcClass}">${wc}</td>
          <td class="stats-count-cell ${bcClass}">${bc}</td>
        </tr>`;
    }

    tbody.innerHTML = html;
    container.hidden = false;
    if (infoEmptyState) infoEmptyState.hidden = true;
  }

  /** White POV pawns after the last played move; bar uses cached backend data only. */
  const EVAL_BAR_CLAMP = 5;
  const EVAL_EPS = 0.05;
  const EVAL_BAR_PERCENT_MIN = 5;
  const EVAL_BAR_PERCENT_MAX = 95;

  /** Tooltip: clamped pawns (for .toFixed(2)) when not mate. */
  let evalBarTooltipPawns = 0;
  /** Tooltip: e.g. "M3" when position has forced mate; null otherwise. */
  let evalBarTooltipMate = null;

  function applyEvalBarVisuals(fill, percentHeight, evalForTint, isMate) {
    fill.style.height = `${percentHeight}%`;
    fill.style.bottom = "0%";
    fill.className = "eval-fill";
    if (isMate) {
      if (percentHeight >= 99) fill.classList.add("eval-fill--white");
      else fill.classList.add("eval-fill--black");
      return;
    }
    if (evalForTint > EVAL_EPS) fill.classList.add("eval-fill--white");
    else if (evalForTint < -EVAL_EPS) fill.classList.add("eval-fill--black");
    else fill.classList.add("eval-fill--neutral");
  }

  function setEvalBarAria(bar) {
    if (!bar) return;
    const label = evalBarTooltipMate
      ? `Position evaluation, mate in ${evalBarTooltipMate.slice(1)}`
      : `Position evaluation ${evalBarTooltipPawns.toFixed(2)} pawns (White POV)`;
    bar.setAttribute("aria-label", label);
  }

  function updateEvalBar() {
    if (currentMode === "practice") {
      // In practice mode, evaluation is updated dynamically via analyzePracticePosition.
      return;
    }

    if (!cachedAnalysisMoves.length || currentMoveIndex === 0) {
      updateEvalBarFromData(0, null);
      return;
    }

    const move = cachedAnalysisMoves[currentMoveIndex - 1];
    if (!move) {
      updateEvalBarFromData(0, null);
      return;
    }

    updateEvalBarFromScore(move.evaluation_after);
  }

  function updateEvalBarFromScore(score) {
    if (!score || score.type === "terminal") {
      updateEvalBarFromData(0, null);
      return;
    }
    if (score.type === "mate") {
      const whiteWins = score.winner === "white";
      updateEvalBarFromData(whiteWins ? EVAL_BAR_CLAMP : -EVAL_BAR_CLAMP, whiteWins ? score.moves : -score.moves);
      return;
    }
    updateEvalBarFromData(core.scoreToWhitePovPawns(score), null);
  }

  function updateEvalLabels(rawEval, mateRaw) {
    const topLabel = document.getElementById("evalLabelTop");
    const bottomLabel = document.getElementById("evalLabelBottom");
    if (!topLabel || !bottomLabel) return;

    if (typeof rawEval !== "number" || Number.isNaN(rawEval)) {
      topLabel.textContent = "";
      bottomLabel.textContent = "";
      return;
    }

    // Determine who has the advantage/winning side
    let winningSide = "white";
    const hasMate = mateRaw !== null && mateRaw !== undefined && typeof mateRaw === "number" && Number.isFinite(mateRaw);
    if (hasMate) {
      winningSide = (mateRaw !== 0 ? mateRaw > 0 : rawEval > 0) ? "white" : "black";
    } else {
      if (rawEval > 0) winningSide = "white";
      else if (rawEval < 0) winningSide = "black";
      else winningSide = "white"; // neutral
    }

    // Determine position: top or bottom
    let activePosition = "bottom";
    if (!isFlipped) {
      activePosition = (winningSide === "white") ? "bottom" : "top";
    } else {
      activePosition = (winningSide === "white") ? "top" : "bottom";
    }

    // Formatted text
    let text = "";
    if (hasMate) {
      text = `M${Math.abs(Math.trunc(mateRaw))}`;
    } else {
      text = Math.abs(rawEval).toFixed(1);
    }

    // Update texts and visibility
    if (activePosition === "top") {
      topLabel.textContent = text;
      bottomLabel.textContent = "";
      
      // Determine color
      if (!isFlipped) {
        // Normal: top is Black area (light text)
        topLabel.className = "eval-label eval-label-top eval-label--light";
      } else {
        // Flipped: top is White area (dark text)
        topLabel.className = "eval-label eval-label-top eval-label--dark";
      }
    } else {
      bottomLabel.textContent = text;
      topLabel.textContent = "";

      // Determine color
      if (!isFlipped) {
        // Normal: bottom is White area (dark text)
        bottomLabel.className = "eval-label eval-label-bottom eval-label--dark";
      } else {
        // Flipped: bottom is Black area (light text)
        bottomLabel.className = "eval-label eval-label-bottom eval-label--light";
      }
    }
  }

  function updateEvalBarFromData(rawEval, mateRaw) {
    const fill = document.getElementById("evalFill");
    const bar = document.getElementById("evalBar");
    const flipEl = document.getElementById("evalBarFlip");
    if (!fill || !bar) return;

    if (flipEl) flipEl.style.transform = isFlipped ? "scaleY(-1)" : "";

    const neutral = () => {
      evalBarTooltipPawns = 0;
      evalBarTooltipMate = null;
      applyEvalBarVisuals(fill, 50, 0, false);
      setEvalBarAria(bar);
    };

    if (typeof rawEval !== "number" || Number.isNaN(rawEval)) {
      neutral();
      syncEvalTooltipTextIfVisible();
      updateEvalLabels(rawEval, mateRaw);
      return;
    }

    const hasMate =
      mateRaw !== null &&
      mateRaw !== undefined &&
      typeof mateRaw === "number" &&
      Number.isFinite(mateRaw);

    if (hasMate) {
      const whiteMates = mateRaw !== 0 ? mateRaw > 0 : rawEval > 0;
      const percentHeight = whiteMates ? 100 : 0;
      evalBarTooltipMate = `M${Math.abs(Math.trunc(mateRaw))}`;
      evalBarTooltipPawns = Math.max(
        -EVAL_BAR_CLAMP,
        Math.min(EVAL_BAR_CLAMP, rawEval)
      );
      applyEvalBarVisuals(fill, percentHeight, whiteMates ? 1 : -1, true);
      setEvalBarAria(bar);
      syncEvalTooltipTextIfVisible();
      updateEvalLabels(rawEval, mateRaw);
      return;
    }

    evalBarTooltipMate = null;
    const clamped = Math.max(-EVAL_BAR_CLAMP, Math.min(EVAL_BAR_CLAMP, rawEval));
    evalBarTooltipPawns = clamped;
    let percent = 50 + clamped * 8;
    percent = Math.max(EVAL_BAR_PERCENT_MIN, Math.min(EVAL_BAR_PERCENT_MAX, percent));
    applyEvalBarVisuals(fill, percent, clamped, false);
    setEvalBarAria(bar);
    syncEvalTooltipTextIfVisible();
    updateEvalLabels(rawEval, mateRaw);
  }

  function syncEvalTooltipTextIfVisible() {
    const tooltip = document.getElementById("evalTooltip");
    if (!tooltip || tooltip.classList.contains("hidden")) return;
    tooltip.textContent =
      evalBarTooltipMate != null
        ? evalBarTooltipMate
        : evalBarTooltipPawns.toFixed(2);
  }

  function renderMoveLog() {
    const moveLogEl = document.getElementById("moveLog");
    if (!moveLogEl) return;

    if (!moves || moves.length === 0) {
      moveLogEl.innerHTML = '<p class="move-log-placeholder">Analyze a game to see the move history.</p>';
      return;
    }

    let html = "";
    const numRows = Math.ceil(moves.length / 2);

    for (let i = 0; i < numRows; i++) {
      const whiteIdx = i * 2;
      const blackIdx = whiteIdx + 1;

      const whiteMove = moves[whiteIdx];
      const blackMove = blackIdx < moves.length ? moves[blackIdx] : null;

      const whiteMoveData = cachedAnalysisMoves[whiteIdx];
      const blackMoveData = blackMove ? cachedAnalysisMoves[blackIdx] : null;

      const whiteCls = whiteMoveData?.classification || "";
      const blackCls = blackMoveData?.classification || "";

      const whiteDot = whiteCls ? `<span class="eval-dot eval-dot-${whiteCls.toLowerCase()}" title="${classificationLabel(whiteCls)}"></span>` : "";
      const blackDot = blackCls ? `<span class="eval-dot eval-dot-${blackCls.toLowerCase()}" title="${classificationLabel(blackCls)}"></span>` : "";

      const disabledAttr = currentMode === "practice" ? "disabled" : "";

      html += `
        <div class="move-row">
          <div class="move-number">${i + 1}.</div>
          <div>
            <button type="button" class="move-btn" data-idx="${whiteIdx + 1}" ${disabledAttr}>
              ${whiteMove} ${whiteDot}
            </button>
          </div>
          <div>
            ${blackMove ? `
              <button type="button" class="move-btn" data-idx="${blackIdx + 1}" ${disabledAttr}>
                ${blackMove} ${blackDot}
              </button>
            ` : ""}
          </div>
        </div>
      `;
    }

    moveLogEl.innerHTML = html;
    updateMoveLogState(false);
  }

  function updateMoveLogState(shouldScroll = true) {
    const moveLogEl = document.getElementById("moveLog");
    if (!moveLogEl) return;
    moveLogEl.querySelectorAll(".move-btn").forEach((btn) => {
      const index = Number(btn.dataset.idx);
      btn.classList.toggle("active", index === currentMoveIndex);
      btn.disabled = currentMode === "practice";
    });
    const activeBtn = moveLogEl.querySelector(".move-btn.active");
    if (activeBtn && shouldScroll) {
      const containerRect = moveLogEl.getBoundingClientRect();
      const buttonRect = activeBtn.getBoundingClientRect();
      if (buttonRect.top < containerRect.top) {
        moveLogEl.scrollTop -= containerRect.top - buttonRect.top;
      } else if (buttonRect.bottom > containerRect.bottom) {
        moveLogEl.scrollTop += buttonRect.bottom - containerRect.bottom;
      }
    }
  }

  document.getElementById("moveLog")?.addEventListener("click", (event) => {
    const button = event.target.closest(".move-btn");
    if (!button || button.disabled) return;
    goToMove(Number(button.dataset.idx));
  });

  function wireEvalBarTooltip() {
    // Tooltip hover disabled in favor of permanently visible labels inside the eval bar.
  }

  function clearAnalysisUI() {
    window.ChessVerseCoach?.clearAnalysis();
    selectedSquare = null;
    removeHighlights();
    const whiteEl = document.getElementById("whiteAccuracy");
    const blackEl = document.getElementById("blackAccuracy");
    const empty = document.getElementById("analysisEmptyState");
    const detail = document.getElementById("currentMoveDetail");

    cachedAnalysisMoves = [];
    window.cachedAnalysisMoves = cachedAnalysisMoves;

    if (whiteEl) whiteEl.textContent = "--%";
    if (blackEl) blackEl.textContent = "--%";

    if (empty) {
      empty.hidden = false;
      empty.innerHTML =
        'No analysis yet. Paste a PGN and click <b>Analyze Game</b>.';
    }
    if (detail) detail.hidden = true;

    const headline = document.getElementById("panelMoveHeadline");
    const clsEl = document.getElementById("panelClassification");
    const lossEl = document.getElementById("panelLoss");
    if (headline) headline.textContent = "";
    if (clsEl) {
      clsEl.textContent = "";
      clsEl.className = "panel-classification";
    }
    if (lossEl) lossEl.textContent = "";
    const bestMoveSection = document.getElementById("panelBestMoveSection");
    if (bestMoveSection) bestMoveSection.hidden = true;
    const evalTip = document.getElementById("evalTooltip");
    if (evalTip) {
      evalTip.classList.add("hidden");
      evalTip.setAttribute("aria-hidden", "true");
    }
    clearBoardAnnotations();
    const statsBreakdown = document.getElementById("statsBreakdown");
    if (statsBreakdown) statsBreakdown.hidden = true;
    if (infoEmptyState) infoEmptyState.hidden = false;
    updateEvalBar();
    renderMoveLog();
  }

  function renderAnalysis(analysis) {
    const whiteEl = document.getElementById("whiteAccuracy");
    const blackEl = document.getElementById("blackAccuracy");

    if (!analysis || !Array.isArray(analysis.moves) || analysis.moves.length === 0) {
      cachedAnalysisMoves = [];
      window.cachedAnalysisMoves = cachedAnalysisMoves;
      if (whiteEl) whiteEl.textContent = "--%";
      if (blackEl) blackEl.textContent = "--%";
      const empty = document.getElementById("analysisEmptyState");
      const detail = document.getElementById("currentMoveDetail");
      if (empty) {
        empty.hidden = false;
        empty.innerHTML =
          "No move analysis in response. Check PGN and Stockfish setup.";
      }
      if (detail) detail.hidden = true;
      updateEvalBar();
      return;
    }

    cachedAnalysisMoves = analysis.moves;
    window.cachedAnalysisMoves = cachedAnalysisMoves;

    if (whiteEl) whiteEl.textContent = formatPercent(analysis.white_accuracy_percent);
    if (blackEl) blackEl.textContent = formatPercent(analysis.black_accuracy_percent);

    renderStatsBreakdown();
    updateAnalysisPanel();
    updateEvalBar();
  }

  // UI elements for navigation and player names.
  const prevBtn = document.getElementById("prevBtn");
  const nextBtn = document.getElementById("nextBtn");
  const flipBtn = document.getElementById("flipBtn");
  const playerBlackEl = document.getElementById("playerBlack");
  const playerWhiteEl = document.getElementById("playerWhite");

  if (!boardEl) {
    console.error("Missing #board element in DOM.");
    return;
  }

  function applyPlayersForFlip() {
    if (!playerBlackEl || !playerWhiteEl) return;

    if (!isFlipped) {
      // Normal orientation:
      // Top = Black, Bottom = White
      playerBlackEl.textContent = blackName;
      playerWhiteEl.textContent = whiteName;
    } else {
      // Flipped orientation:
      // Top = White, Bottom = Black
      playerBlackEl.textContent = whiteName;
      playerWhiteEl.textContent = blackName;
    }
  }

  function updatePlayersUI(gameData) {
    const headers = gameData && typeof gameData === "object" ? gameData.headers || {} : {};
    if (playerWhiteEl) {
      const w = headers.White;
      whiteName = w || "White";
    }
    if (playerBlackEl) {
      const b = headers.Black;
      blackName = b || "Black";
    }

    applyPlayersForFlip();
  }

  function extractFromPGN() {
    return {
      result: loadedGameHeaders.Result || "",
      termination: loadedGameHeaders.Termination || "",
    };
  }

  function hideGameResultOverlay() {
    const overlay = document.getElementById("gameResultOverlay");
    if (!overlay) return;
    overlay.classList.add("hidden");
    overlay.setAttribute("aria-hidden", "true");
  }

  function showGameResult() {
    const overlay = document.getElementById("gameResultOverlay");
    const titleEl = document.getElementById("resultTitle");
    const reasonEl = document.getElementById("resultReason");
    if (!overlay || !titleEl || !reasonEl) return;

    const { result, termination } = extractFromPGN();

    let title = "Game over";
    if (result === "1-0") title = "White Wins";
    else if (result === "0-1") title = "Black Wins";
    else if (result === "1/2-1/2") title = "Draw";
    else if (chess?.in_checkmate()) title = chess.turn() === "w" ? "Black Wins" : "White Wins";

    titleEl.textContent = title;

    const derivedReason = termination || (chess?.in_checkmate() ? "Checkmate" : chess?.in_stalemate() ? "Stalemate" : "");
    if (derivedReason) {
      reasonEl.textContent = derivedReason;
      reasonEl.hidden = false;
    } else {
      reasonEl.textContent = "";
      reasonEl.hidden = true;
    }

    overlay.classList.remove("hidden");
    overlay.setAttribute("aria-hidden", "false");
  }

  function syncGameResultOverlay() {
    const result = loadedGameHeaders.Result || "";
    const terminalResult = ["1-0", "0-1", "1/2-1/2"].includes(result);
    const boardIsTerminal = Boolean(chess?.game_over?.());
    if (moves.length > 0 && currentMoveIndex === moves.length && (terminalResult || boardIsTerminal)) {
      showGameResult();
    } else {
      hideGameResultOverlay();
    }
  }

  function updateNavButtons() {
    if (currentMode === "practice") {
      if (prevBtn) prevBtn.disabled = (practiceCurrentIndex <= 0);
      if (nextBtn) nextBtn.disabled = (practiceCurrentIndex >= practiceFens.length - 1);
      return;
    }
    const chessAvailable = !!(chess && typeof chess.fen === "function");
    const hasMoves = moves && Array.isArray(moves) && moves.length > 0;
    if (prevBtn)
      prevBtn.disabled = !chessAvailable || !hasMoves || currentMoveIndex <= 0;
    if (nextBtn)
      nextBtn.disabled =
        !chessAvailable || !hasMoves || currentMoveIndex >= moves.length;
  }

  function classificationPanelClass(cls) {
    const v = (cls || "").toString().toLowerCase();
    const map = {
      brilliant: "panel-cls-brilliant",
      great: "panel-cls-great",
      best: "panel-cls-best",
      excellent: "panel-cls-excellent",
      good: "panel-cls-good",
      inaccuracy: "panel-cls-inaccuracy",
      mistake: "panel-cls-mistake",
      blunder: "panel-cls-blunder",
      miss: "panel-cls-miss",
      book: "panel-cls-book",
    };
    return map[v] || "panel-cls-good";
  }

  function classificationWithEmoji(cls) {
    const label = classificationLabel(cls);
    const v = (cls || "").toString().toLowerCase();
    if (v === "blunder") return `${label} ❌`;
    return label;
  }

  function updateAnalysisPanel() {
    const empty = document.getElementById("analysisEmptyState");
    const detail = document.getElementById("currentMoveDetail");
    const headline = document.getElementById("panelMoveHeadline");
    const clsEl = document.getElementById("panelClassification");
    const lossEl = document.getElementById("panelLoss");

    if (!empty || !detail || !headline || !clsEl || !lossEl) return;

    if (!cachedAnalysisMoves || cachedAnalysisMoves.length === 0) {
      empty.hidden = false;
      empty.innerHTML =
        'No analysis yet. Paste a PGN and click <b>Analyze Game</b>.';
      detail.hidden = true;
      headline.textContent = "";
      clsEl.textContent = "";
      clsEl.className = "panel-classification";
      lossEl.textContent = "";
      return;
    }

    if (currentMoveIndex <= 0) {
      empty.hidden = false;
      empty.textContent =
        "Start position. Use Next ➡ or the right arrow to step through moves.";
      detail.hidden = true;
      headline.textContent = "";
      clsEl.textContent = "";
      clsEl.className = "panel-classification";
      lossEl.textContent = "";
      return;
    }

    const move = cachedAnalysisMoves[currentMoveIndex - 1];
    if (!move) {
      empty.hidden = false;
      empty.textContent = "No data for this position.";
      detail.hidden = true;
      return;
    }

    empty.hidden = true;
    detail.hidden = false;

    const ply = move.ply;
    const san = move.san || "—";
    const moveNo = ply != null ? Math.ceil(ply / 2) : currentMoveIndex;
    headline.textContent = `Move ${moveNo}: ${san}`;

    const cls = move.classification;
    clsEl.textContent = classificationWithEmoji(cls);
    clsEl.className = `panel-classification ${classificationPanelClass(cls)}`;

    const loss = move.win_probability_loss;
    if (typeof loss === "number" && !Number.isNaN(loss)) {
      lossEl.textContent = `Win probability loss: ${loss.toFixed(2)}%`;
    } else {
      lossEl.textContent = "";
    }

    const bestMoveSection = document.getElementById("panelBestMoveSection");
    const bestMoveEl = document.getElementById("panelBestMove");
    const pvEl = document.getElementById("panelPV");

    const isSuboptimal = ["inaccuracy", "mistake", "blunder", "miss"].includes(cls ? cls.toLowerCase() : "");

    if (bestMoveSection && bestMoveEl && pvEl) {
      if (isSuboptimal && move.best_move) {
        bestMoveEl.textContent = move.best_move;
        pvEl.textContent = move.pv && move.pv.length > 0 ? move.pv.join(" ") : "—";
        bestMoveSection.hidden = false;
      } else {
        bestMoveSection.hidden = true;
      }
    }
  }

  function updateBoard() {
    if (!chess || !chessboard) return;
    const fen = positionFens[currentMoveIndex] || startingFen || new window.Chess().fen();
    if (!chess.load(fen)) return;
    currentFen = chess.fen();
    // Keep orientation as-is; only swap piece locations for the current fen.
    if (typeof chessboard.position === "function") {
      chessboard.position(currentFen, false);
    }
  }

  function goToPracticeMove(index) {
    if (index < 0 || index >= practiceFens.length) return;
    selectedSquare = null;
    removeHighlights();
    practiceCurrentIndex = index;
    const fen = practiceFens[practiceCurrentIndex];
    chess.load(fen);
    currentFen = fen;
    if (chessboard && typeof chessboard.position === "function") {
      chessboard.position(currentFen, false);
    }
    updateNavButtons();
    analyzePracticePosition(currentFen);
    playSound("move");
  }

  function goToMove(index, playSoundEffect) {
    selectedSquare = null;
    removeHighlights();
    clearBoardAnnotations();
    const max = moves && Array.isArray(moves) ? moves.length : 0;
    const prevIdx = currentMoveIndex;
    currentMoveIndex = Math.max(0, Math.min(index, max));
    updateBoard();
    updateNavButtons();
    updateAnalysisPanel();
    updateEvalBar();
    syncGameResultOverlay();
    updateMoveLogState();
    applyBoardAnnotations();

    // Sound effects (Feature 8)
    if (playSoundEffect && currentMoveIndex !== prevIdx && currentMoveIndex > 0) {
      const san = moves[currentMoveIndex - 1] || "";
      if (currentMoveIndex === moves.length && cachedAnalysisMoves.length > 0 && chess?.game_over?.()) {
        playSound("game-over");
      } else {
        playSound(detectMoveSound(san));
      }
    }
  }

  function nextMove() {
    if (currentMode === "practice") {
      goToPracticeMove(practiceCurrentIndex + 1);
    } else {
      goToMove(currentMoveIndex + 1, true);
    }
  }

  function prevMove() {
    if (currentMode === "practice") {
      goToPracticeMove(practiceCurrentIndex - 1);
    } else {
      goToMove(currentMoveIndex - 1, true);
    }
  }

  function flipBoard() {
    if (!chessboard) return;
    try {
      chessboard.flip();
      isFlipped = !isFlipped;
      // Re-apply current position after flipping.
      if (currentFen) chessboard.position(currentFen, false);
      applyPlayersForFlip();
      updateEvalBar();
    } catch (e) {
      // Fail silently to avoid user-facing disruption.
      // Keep silent; flip failures should not break navigation.
    }
  }

  function loadGame(parsedGame, backendData) {
    const analysis = backendData?.analysis || null;
    loadedGameHeaders = parsedGame.headers || {};
    moves = parsedGame.moves.map((move) => move.san);
    moveUcis = parsedGame.moves.map((move) => move.uci);
    positionFens = parsedGame.positions.slice();
    startingFen = parsedGame.startFen;

    currentMoveIndex = 0;
    currentFen = null;

    updatePlayersUI(parsedGame);
    renderAnalysis(analysis);
    renderMoveLog();
    window.ChessVerseCoach?.setAnalysis(parsedGame, analysis);

    updateNavButtons();
    goToMove(0);
  }

  // Wire navigation UI.
  if (prevBtn) prevBtn.addEventListener("click", prevMove);
  if (nextBtn) nextBtn.addEventListener("click", nextMove);
  if (flipBtn) flipBtn.addEventListener("click", flipBoard);

  // Sound toggle button (Feature 8)
  const soundToggleBtn = document.getElementById("soundToggle");
  if (soundToggleBtn) {
    soundToggleBtn.addEventListener("click", () => {
      soundEnabled = !soundEnabled;
      soundToggleBtn.textContent = soundEnabled ? "🔊" : "🔇";
      soundToggleBtn.classList.toggle("muted", !soundEnabled);
      soundToggleBtn.title = soundEnabled ? "Sound on" : "Sound off";
      soundToggleBtn.setAttribute("aria-label", soundEnabled ? "Turn sound off" : "Turn sound on");
      soundToggleBtn.setAttribute("aria-pressed", String(soundEnabled));
    });
  }

  function removeHighlights() {
    const boardEl = document.getElementById("board");
    if (!boardEl) return;
    boardEl.querySelectorAll(".square-hint").forEach(el => el.classList.remove("square-hint"));
    boardEl.querySelectorAll(".square-capture-hint").forEach(el => el.classList.remove("square-capture-hint"));
    boardEl.querySelectorAll(".square-selected").forEach(el => el.classList.remove("square-selected"));
  }

  function highlightSquare(square, type) {
    const boardEl = document.getElementById("board");
    if (!boardEl) return;
    const el = boardEl.querySelector(`[data-square="${square}"]`);
    if (el) {
      if (type === "hint") el.classList.add("square-hint");
      else if (type === "capture") el.classList.add("square-capture-hint");
      else if (type === "selected") el.classList.add("square-selected");
    }
  }

  const promotionOverlay = document.getElementById("promotionOverlay");
  let pendingPromotion = null;

  function closePromotionPicker() {
    pendingPromotion = null;
    promotionOverlay?.classList.add("hidden");
    promotionOverlay?.setAttribute("aria-hidden", "true");
  }

  function requestPromotion(from, to) {
    pendingPromotion = { from, to };
    promotionOverlay?.classList.remove("hidden");
    promotionOverlay?.setAttribute("aria-hidden", "false");
    promotionOverlay?.querySelector("[data-promotion='q']")?.focus();
  }

  function commitPracticeMove(from, to, promotion) {
    const madeMove = chess?.move({ from, to, promotion });
    if (!madeMove) return false;
    playSound(detectMoveSound(madeMove.san));
    currentFen = chess.fen();
    chessboard?.position(currentFen, false);
    practiceFens = practiceFens.slice(0, practiceCurrentIndex + 1);
    practiceFens.push(currentFen);
    practiceCurrentIndex = practiceFens.length - 1;
    updateNavButtons();
    analyzePracticePosition(currentFen);
    return true;
  }

  promotionOverlay?.addEventListener("click", (event) => {
    const promotionButton = event.target.closest("[data-promotion]");
    if (promotionButton && pendingPromotion) {
      const move = pendingPromotion;
      const promotion = promotionButton.getAttribute("data-promotion");
      closePromotionPicker();
      commitPracticeMove(move.from, move.to, promotion);
      return;
    }
    if (event.target.closest(".promotion-cancel") || event.target === promotionOverlay) closePromotionPicker();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !promotionOverlay?.classList.contains("hidden")) closePromotionPicker();
  });

  function handleSquareClick(square) {
    if (currentMode !== "practice") return;
    if (!chess || typeof chess.moves !== "function") return;

    // Check if the clicked square has a piece of the current turn
    const piece = chess.get(square);
    const turn = chess.turn();

    // If we click on our own piece, we select it and highlight moves
    if (piece && piece.color === turn) {
      removeHighlights();
      selectedSquare = square;
      highlightSquare(square, "selected");

      // Find all legal moves for this piece
      const legalMoves = chess.moves({ square: square, verbose: true });
      legalMoves.forEach(m => {
        const destPiece = chess.get(m.to);
        if (destPiece) {
          highlightSquare(m.to, "capture");
        } else {
          highlightSquare(m.to, "hint");
        }
      });
      return;
    }

    // If we already have a selected square and click a target square
    if (selectedSquare) {
      const legalMoves = chess.moves({ square: selectedSquare, verbose: true });
      const candidates = legalMoves.filter(m => m.to === square);
      const move = candidates[0];

      if (move) {
        try {
          if (candidates.some((candidate) => candidate.promotion)) requestPromotion(selectedSquare, square);
          else commitPracticeMove(selectedSquare, square);
        } catch (e) {
          console.error(e);
        }
        selectedSquare = null;
        removeHighlights();
      } else {
        selectedSquare = null;
        removeHighlights();
      }
    }
  }

  function onDragStart(source, piece, position, orientation) {
    if (currentMode !== "practice" || !chess) return false;
    const sourcePiece = chess.get(source);
    return Boolean(sourcePiece && sourcePiece.color === chess.turn());
  }

  function onDrop(source, target) {
    if (source !== target) {
      lastMousedownSquare = null;
    }
    selectedSquare = null;
    removeHighlights();
    if (!chess || typeof chess.move !== "function") return "snapback";
    try {
      const candidates = chess.moves({ square: source, verbose: true }).filter((move) => move.to === target);
      if (!candidates.length) return "snapback";
      if (candidates.some((move) => move.promotion)) {
        requestPromotion(source, target);
        return "snapback";
      }
      if (!commitPracticeMove(source, target)) return "snapback";
    } catch (e) {
      return "snapback";
    }
  }

  function onSnapEnd() {
    if (chessboard && typeof chessboard.position === "function") {
      chessboard.position(chess.fen());
    }
  }

  async function analyzePracticePosition(fen) {
    const thisOperation = ++operationId;
    const sessionId = engine.startSession("Practice position changed.");
    const headline = document.getElementById("panelMoveHeadline");
    const clsEl = document.getElementById("panelClassification");
    const lossEl = document.getElementById("panelLoss");
    const bestMoveSection = document.getElementById("panelBestMoveSection");
    const bestMoveEl = document.getElementById("panelBestMove");
    const pvEl = document.getElementById("panelPV");
    const detail = document.getElementById("currentMoveDetail");
    const empty = document.getElementById("analysisEmptyState");

    if (empty) empty.hidden = true;
    if (detail) detail.hidden = false;

    if (headline) headline.textContent = "Analyzing Practice Position...";
    if (clsEl) {
      clsEl.textContent = "";
      clsEl.className = "panel-classification";
    }
    if (lossEl) lossEl.textContent = "";
    if (bestMoveSection) bestMoveSection.hidden = true;

    setLoading(true, "Evaluating position...");

    try {
      const analysis = await engine.analyzePosition(fen, 14, { sessionId });
      if (thisOperation !== operationId || currentMode !== "practice") return;
      const score = analysis.score;
      const pv = getPvSan(fen, analysis.pvUci, 5);
      const bestMove = pv[0] || analysis.bestMoveUci;

      if (headline) {
        if (score.type === "mate") {
          const winner = score.winner === "white" ? "White" : "Black";
          headline.textContent = score.moves === 0
            ? `Checkmate (${winner} wins)`
            : `Mate in ${score.moves} (${winner} wins)`;
        } else if (score.type === "terminal") {
          headline.textContent = "Drawn position";
        } else {
          const pawns = core.scoreToWhitePovPawns(score);
          headline.textContent = `Evaluation: ${pawns > 0 ? "+" : ""}${pawns.toFixed(2)} (White POV)`;
        }
      }

      if (clsEl) {
        clsEl.textContent = "Practice Mode";
        clsEl.className = "panel-classification panel-cls-book";
      }

      if (bestMove) {
        if (lossEl) lossEl.textContent = `Stockfish recommended: ${bestMove}`;
        if (bestMoveSection && bestMoveEl && pvEl) {
          bestMoveEl.textContent = bestMove;
          pvEl.textContent = pv && pv.length > 0 ? pv.join(" ") : "—";
          bestMoveSection.hidden = false;
        }
      } else {
        if (lossEl) lossEl.textContent = "";
        if (bestMoveSection) bestMoveSection.hidden = true;
      }

      updateEvalBarFromScore(score);
    } catch (e) {
      if (e?.name === "AbortError") return;
      if (thisOperation !== operationId) return;
      if (headline) headline.textContent = "Analysis failed.";
      if (lossEl) lossEl.textContent = e.message || String(e);
    } finally {
      if (thisOperation === operationId) setLoading(false);
    }
  }

  const modeReviewBtn = document.getElementById("modeReviewBtn");
  const modePracticeBtn = document.getElementById("modePracticeBtn");

  function setMode(mode) {
    if (currentMode === mode) return;
    closePromotionPicker();
    cancelCurrentAnalysis("Mode changed.");
    currentMode = mode;

    if (mode === "review") {
      if (modeReviewBtn) modeReviewBtn.classList.add("active");
      if (modePracticeBtn) modePracticeBtn.classList.remove("active");
      modeReviewBtn?.setAttribute("aria-pressed", "true");
      modePracticeBtn?.setAttribute("aria-pressed", "false");

      setStatus("Review Mode", "ok");
      updateNavButtons();
      updateBoard();
      updateAnalysisPanel();
      updateEvalBar();
      updateMoveLogState(false);
    } else {
      if (modeReviewBtn) modeReviewBtn.classList.remove("active");
      if (modePracticeBtn) modePracticeBtn.classList.add("active");
      modeReviewBtn?.setAttribute("aria-pressed", "false");
      modePracticeBtn?.setAttribute("aria-pressed", "true");

      setStatus("Practice Mode - Click pieces to play variations", "ok");

      practiceStartFen = currentFen || "start";
      practiceFens = [practiceStartFen];
      practiceCurrentIndex = 0;
      updateNavButtons();
      updateMoveLogState(false);
      analyzePracticePosition(practiceStartFen);
    }
  }

  if (modeReviewBtn) modeReviewBtn.addEventListener("click", () => setMode("review"));
  if (modePracticeBtn) modePracticeBtn.addEventListener("click", () => setMode("practice"));

  // Initialize chessboard.js + chess.js (local static files).
  try {
    if (typeof window.Chessboard === "function") {
      // chessboard.js expects an element id or DOM element.
      chessboard = window.Chessboard("board", {
        draggable: true,
        position: "start",
        // Local piece images so the app works without internet access.
        pieceTheme: "/static/img/chesspieces/wikipedia/{piece}.png",
        onDragStart: onDragStart,
        onDrop: onDrop,
        onSnapEnd: onSnapEnd
      });

      let resizeFrame = null;
      window.addEventListener("resize", () => {
        if (resizeFrame !== null) return;
        resizeFrame = window.requestAnimationFrame(() => {
          resizeFrame = null;
          if (chessboard && typeof chessboard.resize === "function") chessboard.resize();
        });
      }, { passive: true });
    } else {
      console.error("chessboard.js not available.");
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
    }

    if (typeof window.Chess === "function") {
      chess = new window.Chess();
    } else {
      console.error("chess.js not available (required for navigation).");
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
      // Do not show a red UI error message to the user.
      setStatus("Move navigation disabled (client chess.js missing).", "ok");
    }
  } catch (e) {
    console.error("Failed to initialize chess libraries:", e);
    setStatus("Client chess libraries failed to load.", "ok");
  }

  // Initialize UI state.
  updatePlayersUI({ headers: {} });
  updateNavButtons();
  if (chess && typeof chess.fen === "function") currentFen = chess.fen();
  wireEvalBarTooltip();
  updateEvalBar();

  // Click-to-move square click handler
  if (boardEl) {
    const handleStart = (square, isTouch) => {
      if (isTouch) lastTouchTime = Date.now();
      else if (Date.now() - lastTouchTime < 1000) return;

      lastMousedownSquare = square;
      lastMousedownTime = Date.now();
    };

    const handleEnd = (square, isTouch) => {
      if (isTouch) lastTouchTime = Date.now();
      else if (Date.now() - lastTouchTime < 1000) return;

      if (lastMousedownSquare && square === lastMousedownSquare && (Date.now() - lastMousedownTime) < 350) {
        handleSquareClick(square);
      }
      lastMousedownSquare = null;
    };

    boardEl.addEventListener("mousedown", (e) => {
      if (currentMode !== "practice") return;
      const squareEl = e.target.closest("[data-square]");
      if (squareEl) {
        handleStart(squareEl.getAttribute("data-square"), false);
      } else {
        lastMousedownSquare = null;
      }
    }, true);

    boardEl.addEventListener("mouseup", (e) => {
      if (currentMode !== "practice") return;
      if (!lastMousedownSquare) return;

      const squareEl = e.target.closest("[data-square]");
      const square = squareEl ? squareEl.getAttribute("data-square") : null;
      handleEnd(square, false);
    }, true);

    boardEl.addEventListener("touchstart", (e) => {
      if (currentMode !== "practice") return;
      if (e.touches && e.touches.length > 0) {
        const squareEl = e.touches[0].target.closest("[data-square]");
        if (squareEl) {
          handleStart(squareEl.getAttribute("data-square"), true);
          return;
        }
      }
      lastMousedownSquare = null;
    }, { capture: true, passive: true });

    boardEl.addEventListener("touchend", (e) => {
      if (currentMode !== "practice") return;
      if (!lastMousedownSquare) return;

      const squareEl = e.target.closest("[data-square]");
      const square = squareEl ? squareEl.getAttribute("data-square") : null;
      handleEnd(square, true);
    }, { capture: true, passive: true });
  }

  // Keyboard navigation (global).
  // Prevent default scrolling behavior for arrow keys.
  document.addEventListener("keydown", (e) => {
    const target = e.target;
    if (target instanceof Element && target.closest("input, textarea, select, button, [contenteditable='true']")) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      nextMove();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      prevMove();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (currentMode === "practice") {
        goToPracticeMove(0);
      } else {
        goToMove(0);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (currentMode === "practice") {
        goToPracticeMove(practiceFens.length - 1);
      } else {
        goToMove(moves.length);
      }
    }
  });

  resetBtn.addEventListener("click", () => {
    try {
      closePromotionPicker();
      cancelCurrentAnalysis("Board reset.");
      if (currentMode === "practice") {
        if (chess && typeof chess.load === "function") {
          chess.load(practiceStartFen);
          currentFen = chess.fen();
          if (chessboard && typeof chessboard.position === "function") {
            chessboard.position(currentFen, false);
          }
          practiceFens = [practiceStartFen];
          practiceCurrentIndex = 0;
          updateNavButtons();
          analyzePracticePosition(currentFen);
        }
        setStatus("Practice position reset to original game move.", "ok");
        return;
      }

      moves = [];
      moveUcis = [];
      positionFens = [];
      startingFen = null;
      currentMoveIndex = 0;
      currentFen = null;
      loadedGameHeaders = {};

      setStatus("Board reset.", "ok");
      clearAnalysisUI();
      updatePlayersUI({ headers: {} });
      updateNavButtons();
      updateAnalysisPanel();
      goToMove(0);
    } catch (e) {
      setStatus(`Reset failed: ${e?.message || String(e)}`, "error");
    }
  });

  document.getElementById("resultReviewBtn")?.addEventListener("click", () => {
    hideGameResultOverlay();
    goToMove(0);
  });

  analyzeBtn.addEventListener("click", async () => {
    let parsedGame;
    try {
      parsedGame = core.parsePgn(pgnInput.value, window.Chess);
      setPgnModalError("");
    } catch (error) {
      const message = error?.message || "That PGN could not be parsed.";
      setPgnModalError(message);
      setStatus(message, "error");
      return;
    }

    const thisOperation = ++operationId;
    const sessionId = engine.startSession("A new game analysis started.");
    analyzeBtn.disabled = true;

    clearAnalysisUI();
    loadedGameHeaders = {};
    moves = [];
    moveUcis = [];
    positionFens = parsedGame.positions.slice();
    startingFen = parsedGame.startFen;
    currentMoveIndex = 0;
    currentFen = parsedGame.startFen;
    updatePlayersUI(parsedGame);
    updateNavButtons();
    updateBoard();
    closePgnModal();

    try {
      setLoading(true, "Analyzing game...");
      const report = await analyzeGameMainline(parsedGame, (ply, total) => {
        if (thisOperation !== operationId) return;
        const percent = Math.round((ply / Math.max(total, 1)) * 100);
        setLoading(true, `Analyzing move ${ply} of ${total} (${percent}%)...`);
      }, sessionId);
      if (thisOperation !== operationId) return;

      const data = {
        ok: true,
        pgn: parsedGame.normalizedPgn,
        moves_san: parsedGame.moves.map((move) => move.san),
        final_fen: parsedGame.positions[parsedGame.positions.length - 1],
        analysis: report
      };

      setStatus("Analysis ready.", "ok");
      loadGame(parsedGame, data);
    } catch (e) {
      if (e?.name !== "AbortError" && thisOperation === operationId) {
        setStatus(`Analysis failed: ${e?.message || String(e)}`, "error");
      }
    } finally {
      if (thisOperation === operationId) {
        setLoading(false);
        analyzeBtn.disabled = false;
      }
    }
  });

  // ─── PGN Modal open/close logic ───
  const pgnModalOverlay = document.getElementById("pgnModalOverlay");
  const openPgnModalBtn = document.getElementById("openPgnModal");
  const closePgnModalBtn = document.getElementById("closePgnModal");
  const pgnModalError = document.getElementById("pgnModalError");
  const cancelAnalysisBtn = document.getElementById("cancelAnalysisBtn");
  let modalOpener = null;

  function setPgnModalError(message) {
    if (!pgnModalError) return;
    pgnModalError.textContent = message;
    pgnModalError.hidden = !message;
  }

  function openPgnModal() {
    if (pgnModalOverlay) {
      modalOpener = document.activeElement;
      pgnModalOverlay.classList.remove("hidden");
      pgnModalOverlay.setAttribute("aria-hidden", "false");
      if (pgnInput) pgnInput.focus();
    }
  }

  function closePgnModal() {
    if (pgnModalOverlay) {
      pgnModalOverlay.classList.add("hidden");
      pgnModalOverlay.setAttribute("aria-hidden", "true");
      if (modalOpener instanceof HTMLElement) modalOpener.focus();
    }
  }

  if (openPgnModalBtn) openPgnModalBtn.addEventListener("click", openPgnModal);
  if (closePgnModalBtn) closePgnModalBtn.addEventListener("click", closePgnModal);

  // Close modal on backdrop click
  if (pgnModalOverlay) {
    pgnModalOverlay.addEventListener("click", (e) => {
      if (e.target === pgnModalOverlay) closePgnModal();
    });
  }

  cancelAnalysisBtn?.addEventListener("click", () => {
    cancelCurrentAnalysis("Canceled by user.");
    setStatus("Analysis canceled.", "ok");
  });

  pgnInput?.addEventListener("input", () => setPgnModalError(""));

  // Close modal on Escape and keep keyboard focus inside it.
  document.addEventListener("keydown", (e) => {
    if (!pgnModalOverlay || pgnModalOverlay.classList.contains("hidden")) return;
    if (e.key === "Escape") return closePgnModal();
    if (e.key !== "Tab") return;
    const focusable = Array.from(pgnModalOverlay.querySelectorAll("button:not([disabled]), textarea:not([disabled])"));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  window.addEventListener("beforeunload", () => engine.destroy(), { once: true });
});
