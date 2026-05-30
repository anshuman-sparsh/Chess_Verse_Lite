function extractSanTokensFromPgn(pgn) {
  // Basic PGN sanitization for starter usage.
  // - Removes tag pairs: [Event "..."]
  // - Removes comments: { ... }
  // - Removes variations: ( ... )
  // - Removes move numbers and results
  const withoutTags = pgn.replace(/\[[^\]]*\]/g, " ");
  const withoutComments = withoutTags.replace(/\{[^}]*\}/g, " ");
  const withoutVariations = withoutComments.replace(/\([^)]*\)/g, " ");

  // Normalize whitespace and strip move numbers like "1." or "1..."
  const normalized = withoutVariations
    .replace(/\r?\n+/g, " ")
    .replace(/\d+\.(\.\.)?/g, " ");

  // Remove common termination tokens.
  const withoutResults = normalized.replace(
    /(1-0|0-1|1\/2-1\/2|\*)/g,
    " "
  );

  return withoutResults
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

class BrowserStockfish {
  constructor() {
    this.worker = null;
    this.ready = false;
    this.initPromise = null;
  }

  initWorker() {
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise((resolve) => {
      const wasmSupported = typeof WebAssembly === 'object' && 
                            WebAssembly.validate(Uint8Array.of(0x0, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00));
      
      const localPath = wasmSupported ? 'static/js/stockfish.wasm.js' : 'static/js/stockfish.js';
      
      try {
        this.worker = new Worker(localPath);
      } catch (e) {
        console.warn("Failed to load local Stockfish worker, falling back to CDN Blob worker.", e);
        const cdnUrl = wasmSupported
          ? 'https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.wasm.js'
          : 'https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js';
        
        const blobCode = `importScripts("${cdnUrl}");`;
        const blob = new Blob([blobCode], { type: 'application/javascript' });
        this.worker = new Worker(URL.createObjectURL(blob));
      }

      const onReadyMessage = (e) => {
        if (e.data === 'readyok') {
          this.worker.removeEventListener('message', onReadyMessage);
          this.ready = true;
          resolve();
        }
      };

      this.worker.addEventListener('message', onReadyMessage);
      this.worker.postMessage('uci');
      this.worker.postMessage('isready');
    });

    return this.initPromise;
  }

  terminateWorker() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.ready = false;
    this.initPromise = null;
  }

  async analyzePosition(fen, depth = 14) {
    try {
      const tempBoard = new window.Chess(fen);
      if (tempBoard.game_over()) {
        let pawns = 0.0;
        let mate = null;
        if (tempBoard.in_checkmate()) {
          const isWhiteMated = (tempBoard.turn() === 'w');
          mate = isWhiteMated ? -0 : 0;
          pawns = isWhiteMated ? -1000.0 : 1000.0;
        }
        return {
          pawns: pawns,
          mate: mate,
          best_move: null,
          pv: []
        };
      }
    } catch (e) {
      console.warn("Fast-path game over check failed, falling back to worker:", e);
    }

    await this.initWorker();
    
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error("Worker not initialized"));
        return;
      }

      let bestMove = null;
      let lastInfo = { pawns: 0, mate: null, pv: [] };
      const turn = fen.split(' ')[1];
      const isWhiteTurn = (turn === 'w');

      const onMessage = (e) => {
        const line = e.data;
        
        if (line.startsWith('bestmove')) {
          console.log("Stockfish worker [" + fen + "] -> bestmove:", line);
          this.worker.removeEventListener('message', onMessage);
          
          const parts = line.split(' ');
          bestMove = parts[1];

          const pvSan = getPvSan(fen, lastInfo.pv, 5);
          const bestMoveSan = pvSan.length > 0 ? pvSan[0] : null;

          resolve({
            pawns: lastInfo.pawns,
            mate: lastInfo.mate,
            best_move: bestMoveSan || bestMove,
            pv: pvSan
          });
        } else if (line.startsWith('info ')) {
          const parts = line.split(' ');
          
          const scoreIdx = parts.indexOf('score');
          if (scoreIdx !== -1) {
            const scoreType = parts[scoreIdx + 1];
            const scoreVal = parseInt(parts[scoreIdx + 2], 10);
            
            if (scoreType === 'cp') {
              const moverScore = scoreVal / 100.0;
              lastInfo.pawns = isWhiteTurn ? moverScore : -moverScore;
              lastInfo.mate = null;
            } else if (scoreType === 'mate') {
              const moverMate = scoreVal;
              lastInfo.mate = isWhiteTurn ? moverMate : -moverMate;
              
              const mateScore = 100000;
              const cp = (lastInfo.mate > 0) ? mateScore : -mateScore;
              lastInfo.pawns = cp / 100.0;
            }
          }
          
          const pvIdx = parts.indexOf('pv');
          if (pvIdx !== -1) {
            lastInfo.pv = parts.slice(pvIdx + 1);
          }
        }
      };

      this.worker.addEventListener('message', onMessage);
      this.worker.postMessage(`position fen ${fen}`);
      this.worker.postMessage(`go depth ${depth}`);
    });
  }
}

const engine = new BrowserStockfish();

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

async function analyzeGameMainline(pgnText, progressCallback) {
  const sanitized = normalizePgnDoubleNewline(pgnText);
  const gameBoard = new window.Chess();
  if (!gameBoard.load_pgn(sanitized)) {
    throw new Error("Invalid PGN game.");
  }
  
  const mainlineMoves = gameBoard.history({ verbose: true });
  const board = new window.Chess();
  
  let currentFen = board.fen();
  let state = await engine.analyzePosition(currentFen, 14);
  
  const moveRows = [];
  const bookPliesLast = 6;
  const accuracyOpeningSkip = 6;
  
  for (let ply = 1; ply <= mainlineMoves.length; ply++) {
    const moveObj = mainlineMoves[ply - 1];
    const side = moveObj.color;
    const sideLabel = (side === 'w') ? 'white' : 'black';
    const san = moveObj.san;
    const uci = moveObj.from + moveObj.to + (moveObj.promotion || '');
    
    if (progressCallback) {
      progressCallback(ply, mainlineMoves.length);
    }
    
    const evalBefore = state.pawns;
    const bestMove = state.best_move;
    const pv = state.pv;
    
    board.move(moveObj);
    currentFen = board.fen();
    
    state = await engine.analyzePosition(currentFen, 14);
    const evalAfter = state.pawns;
    const mateAfter = state.mate;
    
    let loss = 0;
    if (side === 'w') {
      loss = Math.max(0.0, evalBefore - evalAfter);
    } else {
      loss = Math.max(0.0, evalAfter - evalBefore);
    }
    
    let classification = "good";
    if (ply <= bookPliesLast) {
      classification = "book";
    } else {
      const imp = (side === 'w') ? (evalAfter - evalBefore) : (evalBefore - evalAfter);
      
      if (imp > 2.5) {
        classification = "brilliant";
      } else if (imp > 1.5) {
        classification = "great";
      } else if (loss < 0.1) {
        classification = "best";
      } else if (loss < 0.25) {
        classification = "excellent";
      } else if (loss < 0.5) {
        classification = "good";
      } else if (loss < 1.0) {
        classification = "inaccuracy";
      } else if (loss < 1.5) {
        classification = "mistake";
      } else if (loss < 2.5) {
        classification = "miss";
      } else {
        classification = "blunder";
      }
    }
    
    moveRows.push({
      ply: ply,
      san: san,
      side: sideLabel,
      uci: uci,
      eval_before_pawns: parseFloat(evalBefore.toFixed(3)),
      eval_after_pawns: parseFloat(evalAfter.toFixed(3)),
      mate_after: mateAfter,
      loss_pawns: parseFloat(loss.toFixed(3)),
      classification: classification,
      best_move: bestMove,
      pv: pv
    });
  }
  
  const scores = [];
  const whiteScores = [];
  const blackScores = [];
  for (const r of moveRows) {
    if (r.ply <= accuracyOpeningSkip) continue;
    if (r.eval_before_pawns === undefined || r.eval_before_pawns === null || Number.isNaN(r.eval_before_pawns)) continue;
    if (r.eval_after_pawns === undefined || r.eval_after_pawns === null || Number.isNaN(r.eval_after_pawns)) continue;
    
    // Centipawns before and after from White's POV
    const cpBefore = r.eval_before_pawns * 100.0;
    const cpAfter = r.eval_after_pawns * 100.0;
    
    // Win percentages (0 - 100) using the standard sigmoid function
    const wBefore = 100.0 / (1.0 + Math.exp(-0.00368208 * cpBefore));
    const wAfter = 100.0 / (1.0 + Math.exp(-0.00368208 * cpAfter));
    
    // Loss in win percentage for the active player
    let winDiff = 0.0;
    if (r.side === "white") {
      winDiff = wBefore - wAfter;
    } else {
      winDiff = wAfter - wBefore;
    }
    // Clamp winDiff to >= 0
    winDiff = Math.max(0.0, winDiff);
    
    // Move accuracy using exponential decay (k = 0.035)
    const moveAccuracy = 100.0 * Math.exp(-0.035 * winDiff);
    r.accuracy = parseFloat(moveAccuracy.toFixed(2));
    
    scores.push(moveAccuracy);
    if (r.side === "white") {
      whiteScores.push(moveAccuracy);
    } else {
      blackScores.push(moveAccuracy);
    }
  }
  
  const accuracyPercent = scores.length === 0 ? 0.0 : parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2));
  const whiteAccuracyPercent = whiteScores.length === 0 ? 0.0 : parseFloat((whiteScores.reduce((a, b) => a + b, 0) / whiteScores.length).toFixed(2));
  const blackAccuracyPercent = blackScores.length === 0 ? 0.0 : parseFloat((blackScores.reduce((a, b) => a + b, 0) / blackScores.length).toFixed(2));
  
  return {
    engine: "stockfish.js",
    limit: { depth: 14 },
    classification_opening_book_plies: bookPliesLast,
    accuracy_opening_moves_skipped: accuracyOpeningSkip,
    moves: moveRows,
    accuracy_percent: accuracyPercent,
    white_accuracy_percent: whiteAccuracyPercent,
    black_accuracy_percent: blackAccuracyPercent
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
  if (!el) return;

  if (isLoading) {
    el.textContent = message || "Analyzing...";
    el.classList.remove("hidden");
    el.setAttribute("aria-hidden", "false");
  } else {
    el.classList.add("hidden");
    el.setAttribute("aria-hidden", "true");
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

/** PGN tag value: `[Tag "value"]` */
function extractPgnTagValue(pgn, tag) {
  const safe = (pgn || "").toString();
  const re = new RegExp("\\[" + tag + "\\s+\"([^\"]*)\"\\]", "i");
  const match = safe.match(re);
  return match && match[1] ? match[1].trim() : "";
}

function isStartPosition(fen) {
  if (!fen || fen === "start") return true;
  const cleanFen = fen.trim().split(/\s+/)[0];
  return cleanFen === "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";
}

function normalizePgnDoubleNewline(pgn) {
  const cleanPgn = (pgn || "").trim();
  const lastTagIndex = cleanPgn.lastIndexOf("]");
  if (lastTagIndex !== -1) {
    const headers = cleanPgn.slice(0, lastTagIndex + 1);
    const moves = cleanPgn.slice(lastTagIndex + 1).trim();
    if (moves) {
      return headers + "\n\n" + moves;
    }
  }
  return cleanPgn;
}

document.addEventListener("DOMContentLoaded", () => {
  const boardEl = document.getElementById("board");
  const pgnInput = document.getElementById("pgnInput");
  const analyzeBtn = document.getElementById("analyzeBtn");
  const resetBtn = document.getElementById("resetBtn");

  // Tabs UI Elements
  const tabMovesBtn = document.getElementById("tabMovesBtn");
  const tabInfoBtn = document.getElementById("tabInfoBtn");
  const tabContentMoves = document.getElementById("tabContentMoves");
  const tabContentInfo = document.getElementById("tabContentInfo");
  const infoEmptyState = document.getElementById("infoEmptyState");

  function showTab(tab) {
    if (tab === "moves") {
      tabMovesBtn?.classList.add("active");
      tabInfoBtn?.classList.remove("active");
      tabContentMoves?.removeAttribute("hidden");
      tabContentInfo?.setAttribute("hidden", "true");
    } else if (tab === "info") {
      tabMovesBtn?.classList.remove("active");
      tabInfoBtn?.classList.add("active");
      tabContentMoves?.setAttribute("hidden", "true");
      tabContentInfo?.removeAttribute("hidden");
    }
  }

  tabMovesBtn?.addEventListener("click", () => showTab("moves"));
  tabInfoBtn?.addEventListener("click", () => showTab("info"));

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
  let currentMoveIndex = 0; // number of moves applied from the start position
  let currentFen = null;

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
  let loadedGamePgn = "";

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
          const tempChess = new window.Chess();
          tempChess.reset();
          for (let i = 0; i < currentMoveIndex - 1 && i < moves.length; i++) {
            const token = moves[i];
            const res = tempChess.move(token, { sloppy: false });
            if (!res && moveUcis && moveUcis[i]) {
              const u = moveUcis[i];
              tempChess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u.length > 4 ? u[4] : undefined });
            }
          }
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

    updateEvalBarFromData(move.eval_after_pawns, move.mate_after);
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

      const whiteActive = currentMoveIndex === whiteIdx + 1 ? "active" : "";
      const blackActive = currentMoveIndex === blackIdx + 1 ? "active" : "";

      const disabledAttr = currentMode === "practice" ? "disabled" : "";

      html += `
        <div class="move-row">
          <div class="move-number">${i + 1}.</div>
          <div>
            <button type="button" class="move-btn ${whiteActive}" data-idx="${whiteIdx + 1}" ${disabledAttr}>
              ${whiteMove} ${whiteDot}
            </button>
          </div>
          <div>
            ${blackMove ? `
              <button type="button" class="move-btn ${blackActive}" data-idx="${blackIdx + 1}" ${disabledAttr}>
                ${blackMove} ${blackDot}
              </button>
            ` : ""}
          </div>
        </div>
      `;
    }

    moveLogEl.innerHTML = html;

    moveLogEl.querySelectorAll(".move-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.idx, 10);
        goToMove(idx);
      });
    });

    const activeBtn = moveLogEl.querySelector(".move-btn.active");
    if (activeBtn) {
      activeBtn.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  function wireEvalBarTooltip() {
    // Tooltip hover disabled in favor of permanently visible labels inside the eval bar.
  }

  function clearAnalysisUI() {
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

  function updatePlayersUI(pgnText) {
    if (playerWhiteEl) {
      const w = extractPgnTagValue(pgnText, "White");
      whiteName = w || "White";
    }
    if (playerBlackEl) {
      const b = extractPgnTagValue(pgnText, "Black");
      blackName = b || "Black";
    }

    applyPlayersForFlip();
  }

  function extractFromPGN() {
    return {
      result: extractPgnTagValue(loadedGamePgn, "Result"),
      termination: extractPgnTagValue(loadedGamePgn, "Termination"),
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

    titleEl.textContent = title;

    if (termination) {
      reasonEl.textContent = termination;
      reasonEl.hidden = false;
    } else {
      reasonEl.textContent = "";
      reasonEl.hidden = true;
    }

    overlay.classList.remove("hidden");
    overlay.setAttribute("aria-hidden", "false");
  }

  function syncGameResultOverlay() {
    if (moves.length > 0 && currentMoveIndex === moves.length) {
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

    const loss = move.loss_pawns;
    if (typeof loss === "number" && !Number.isNaN(loss)) {
      lossEl.textContent = `Loss: ${loss} pawns`;
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
    if (!moves || !Array.isArray(moves)) return;

    chess.reset();
    const limit = Math.min(currentMoveIndex, moves.length);

    for (let i = 0; i < limit; i++) {
      const token = moves[i];
      const res = chess.move(token, { sloppy: false });
      if (!res && moveUcis && moveUcis[i]) {
        // Fallback: replay using UCI if SAN fails (helps with edge cases).
        const uci = moveUcis[i];
        const from = uci.slice(0, 2);
        const to = uci.slice(2, 4);
        const promotion = uci.length > 4 ? uci.slice(4, 5).toLowerCase() : undefined;
        const obj = { from, to };
        if (promotion) obj.promotion = promotion;

        const res2 = chess.move(obj);
        if (!res2) break;
      } else if (!res) {
        // Keep UI stable if SAN is unparsable for some reason.
        break;
      }
    }

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
    renderMoveLog();
    applyBoardAnnotations();

    // Sound effects (Feature 8)
    if (playSoundEffect && currentMoveIndex !== prevIdx && currentMoveIndex > 0) {
      const san = moves[currentMoveIndex - 1] || "";
      if (currentMoveIndex === moves.length && cachedAnalysisMoves.length > 0) {
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

  function loadGame(pgnText, backendData) {
    const analysis = backendData?.analysis || null;
    loadedGamePgn = (pgnText || "").trim();
    moves = [];
    moveUcis = [];

    if (analysis && Array.isArray(analysis.moves) && analysis.moves.length > 0) {
      // Keep SAN and UCI arrays aligned by index.
      for (const m of analysis.moves) {
        if (!m || !m.san) continue;
        moves.push(m.san);
        moveUcis.push(m.uci || "");
      }
    } else if (Array.isArray(backendData?.moves_san)) {
      moves = backendData.moves_san;
    }

    currentMoveIndex = 0;
    currentFen = null;

    updatePlayersUI(pgnText);
    renderAnalysis(analysis);

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
      const move = legalMoves.find(m => m.to === square);

      if (move) {
        try {
          const madeMove = chess.move({
            from: selectedSquare,
            to: square,
            promotion: "q"
          });
          if (madeMove) playSound(detectMoveSound(madeMove.san));
          currentFen = chess.fen();
          if (chessboard && typeof chessboard.position === "function") {
            chessboard.position(currentFen);
          }
          practiceFens = practiceFens.slice(0, practiceCurrentIndex + 1);
          practiceFens.push(currentFen);
          practiceCurrentIndex = practiceFens.length - 1;
          updateNavButtons();
          analyzePracticePosition(currentFen);
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
    return false;
  }

  function onDrop(source, target) {
    if (source !== target) {
      lastMousedownSquare = null;
    }
    selectedSquare = null;
    removeHighlights();
    if (!chess || typeof chess.move !== "function") return "snapback";
    try {
      const move = chess.move({
        from: source,
        to: target,
        promotion: "q"
      });
      if (move === null) return "snapback";

      playSound(detectMoveSound(move.san));
      currentFen = chess.fen();
      practiceFens = practiceFens.slice(0, practiceCurrentIndex + 1);
      practiceFens.push(currentFen);
      practiceCurrentIndex = practiceFens.length - 1;
      updateNavButtons();
      analyzePracticePosition(currentFen);
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

    engine.terminateWorker();

    try {
      let score = 0.0;
      let mate = null;
      let bestMove = null;
      let pv = [];

      if (isStartPosition(fen)) {
        score = 0.0;
        mate = null;
        bestMove = "e4";
        pv = ["e4", "e5", "Nf3", "Nc6", "Bb5"];
      } else {
        const analysis = await engine.analyzePosition(fen, 14);
        score = analysis.pawns;
        mate = analysis.mate;
        bestMove = analysis.best_move;
        pv = analysis.pv;
      }

      const isMate = mate !== null && mate !== undefined;

      if (headline) {
        if (isMate) {
          if (mate === 0) {
            const winner = chess.turn() === "b" ? "White" : "Black";
            headline.textContent = `Checkmate (${winner} wins)`;
          } else {
            const winner = mate > 0 ? "White" : "Black";
            headline.textContent = `Mate in ${Math.abs(mate)} (${winner} wins)`;
          }
        } else {
          const sideToMove = chess.turn() === "w" ? "White" : "Black";
          headline.textContent = `Evaluation: ${score > 0 ? "+" : ""}${score.toFixed(2)} (Mover: ${sideToMove})`;
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

      updateEvalBarFromData(score, mate);
    } catch (e) {
      if (headline) headline.textContent = "Analysis failed.";
      if (lossEl) lossEl.textContent = e.message || String(e);
    } finally {
      setLoading(false);
    }
  }

  const modeReviewBtn = document.getElementById("modeReviewBtn");
  const modePracticeBtn = document.getElementById("modePracticeBtn");

  function setMode(mode) {
    if (currentMode === mode) return;
    currentMode = mode;

    if (mode === "review") {
      if (modeReviewBtn) modeReviewBtn.classList.add("active");
      if (modePracticeBtn) modePracticeBtn.classList.remove("active");

      setStatus("Review Mode", "ok");
      updateNavButtons();
      updateBoard();
      updateAnalysisPanel();
      updateEvalBar();
      renderMoveLog();
    } else {
      if (modeReviewBtn) modeReviewBtn.classList.remove("active");
      if (modePracticeBtn) modePracticeBtn.classList.add("active");

      setStatus("Practice Mode - Click pieces to play variations", "ok");

      practiceStartFen = currentFen || "start";
      practiceFens = [practiceStartFen];
      practiceCurrentIndex = 0;
      updateNavButtons();
      renderMoveLog();
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

      window.addEventListener("resize", () => {
        if (chessboard && typeof chessboard.resize === "function") {
          chessboard.resize();
        }
      });
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
  updatePlayersUI("");
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
      engine.terminateWorker();
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
      currentMoveIndex = 0;
      currentFen = null;
      loadedGamePgn = "";

      setStatus("Board reset.", "ok");
      clearAnalysisUI();
      updatePlayersUI("");
      updateNavButtons();
      updateAnalysisPanel();
      goToMove(0);
    } catch (e) {
      setStatus(`Reset failed: ${e?.message || String(e)}`, "error");
    }
  });

  window.restartGame = function restartGame() {
    hideGameResultOverlay();
    goToMove(0);
  };

  analyzeBtn.addEventListener("click", async () => {
    let pgn = (pgnInput.value || "").trim();
    pgn = normalizePgnDoubleNewline(pgn);
    clearAnalysisUI();
    loadedGamePgn = "";
    moves = [];
    currentMoveIndex = 0;
    currentFen = null;
    updateNavButtons();
    updateAnalysisPanel();
    updatePlayersUI(pgn);
    goToMove(0);

    if (!pgn) {
      setStatus("Please paste a PGN game first.", "error");
      return;
    }

    const originalAnalyzeDisabled = analyzeBtn.disabled;
    analyzeBtn.disabled = true;

    engine.terminateWorker();

    try {
      setLoading(true, "Analyzing game...");

      if (chess) {
        chess.reset();
        const tokens = extractSanTokensFromPgn(pgn);

        if (tokens.length === 0) {
          setStatus("Could not find any moves in that PGN.", "error");
          return;
        }

        for (let i = 0; i < tokens.length; i++) {
          const token = tokens[i];
          const move = chess.move(token, { sloppy: false });
          if (!move) {
            setStatus(`Illegal move detected: "${token}"`, "error");
            return;
          }
        }
      }

      const report = await analyzeGameMainline(pgn, (ply, total) => {
        setLoading(true, `Analyzing move ${ply} of ${total}...`);
      });

      const gameBoard = new window.Chess();
      gameBoard.load_pgn(pgn);
      const data = {
        ok: true,
        pgn: pgn,
        moves_san: gameBoard.history({ verbose: true }).map(m => m.san),
        final_fen: gameBoard.fen(),
        analysis: report
      };

      setStatus("Analysis ready.", "ok");
      loadGame(pgn, data);
    } catch (e) {
      setStatus(`Request failed: ${e?.message || String(e)}`, "error");
    } finally {
      setLoading(false);
      analyzeBtn.disabled = originalAnalyzeDisabled;
    }
  });

  // ─── PGN Modal open/close logic ───
  const pgnModalOverlay = document.getElementById("pgnModalOverlay");
  const openPgnModalBtn = document.getElementById("openPgnModal");
  const closePgnModalBtn = document.getElementById("closePgnModal");

  function openPgnModal() {
    if (pgnModalOverlay) {
      pgnModalOverlay.classList.remove("hidden");
      pgnModalOverlay.setAttribute("aria-hidden", "false");
      if (pgnInput) pgnInput.focus();
    }
  }

  function closePgnModal() {
    if (pgnModalOverlay) {
      pgnModalOverlay.classList.add("hidden");
      pgnModalOverlay.setAttribute("aria-hidden", "true");
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

  // Close modal on Escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && pgnModalOverlay && !pgnModalOverlay.classList.contains("hidden")) {
      closePgnModal();
    }
  });

  // Auto-close modal when Analyze Game is clicked
  if (analyzeBtn) {
    analyzeBtn.addEventListener("click", () => {
      closePgnModal();
    });
  }
});

