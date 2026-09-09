const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("browser entrypoint loads shared analysis modules before the application", () => {
  const html = read("index.html");
  assert.ok(html.indexOf("analysis-core.js") < html.indexOf("app.js"));
  assert.ok(html.indexOf("stockfish-controller.js") < html.indexOf("app.js"));
  assert.ok(html.indexOf("coach-core.js") < html.indexOf("coach-client.js"));
  assert.ok(html.indexOf("coach-client.js") < html.indexOf("app.js"));
});

test("interactive controls retain required accessible state and no inline handlers", () => {
  const html = read("index.html");
  assert.match(html, /role="tablist"/);
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /id="cancelAnalysisBtn"/);
  assert.match(html, /id="pgnModalError"[^>]*role="alert"/);
  assert.doesNotMatch(html, /\sonclick=/i);
});

test("analysis progress and PGN-only cancellation live inside the Moves tab", () => {
  const html = read("index.html");
  const app = read("static/js/app.js");
  const boardHeader = html.match(/<div class="board-header">([\s\S]*?)<\/div>/)?.[1] || "";
  const movesPanel = html.match(/id="tabContentMoves"([\s\S]*?)id="tabContentInfo"/)?.[1] || "";
  assert.doesNotMatch(boardHeader, /loadingIndicator|cancelAnalysisBtn/);
  assert.match(movesPanel, /id="analysisProgressRow"/);
  assert.match(movesPanel, /id="loadingIndicator"/);
  assert.match(movesPanel, /id="cancelAnalysisBtn"/);
  assert.match(app, /setLoading\(true, "Analyzing game\.\.\.", true\)/);
  assert.match(app, /setLoading\(true, "Evaluating position\.\.\."\)/);
  assert.match(app, /showTab\("moves"\);\s*closePgnModal\(\)/);
});

test("Reset control lives at the right edge of the analysis tabs", () => {
  const html = read("index.html");
  const css = read("static/css/style.css");
  const tabs = html.match(/<div class="analysis-tabs"[\s\S]*?<div class="analysis-tab-viewport">/)?.[0] || "";
  const modalActions = html.match(/<div class="actions">[\s\S]*?<\/div>/)?.[0] || "";
  assert.match(tabs, /id="resetBtn"/);
  assert.doesNotMatch(modalActions, /id="resetBtn"/);
  assert.match(css, /\.btn-reset-board[\s\S]*margin-left:\s*auto/);
});

test("evaluation bar keeps stable White and Black ownership colors", () => {
  const app = read("static/js/app.js");
  const css = read("static/css/style.css");
  assert.match(app, /fill\.className = "eval-fill eval-fill--white"/);
  assert.doesNotMatch(app, /eval-fill--black|eval-fill--neutral/);
  assert.match(css, /\.eval-bar-track[\s\S]*background:\s*#222/);
  assert.match(css, /\.eval-fill--white[\s\S]*#ffffff/);
});

test("legacy parser and worker-termination paths cannot reappear in app code", () => {
  const app = read("static/js/app.js");
  assert.doesNotMatch(app, /extractSanTokensFromPgn|normalizePgnDoubleNewline|terminateWorker/);
  assert.match(app, /core\.parsePgn/);
  assert.match(app, /engine\.startSession/);
  assert.doesNotMatch(app, /scrollIntoView/);
  assert.match(app, /moveLogEl\.scrollTop/);
});

test("Practice Mode supports delegated click-to-select and click-to-move", () => {
  const app = read("static/js/app.js");
  assert.match(app, /boardEl\.addEventListener\("click"/);
  assert.match(app, /document\.addEventListener\("mouseup"/);
  assert.match(app, /document\.addEventListener\("touchend"/);
  assert.match(app, /handleSquareClick\(square\)/);
  assert.match(app, /chess\.moves\(\{ square: square, verbose: true \}\)/);
  assert.match(app, /commitPracticeMove\(selectedSquare, square\)/);
  assert.match(app, /square-hint/);
  assert.match(app, /square-capture-hint/);
});

test("Load PGN modal exposes safe local recent-game history", () => {
  const html = read("index.html");
  const app = read("static/js/app.js");
  assert.match(html, /id="recentPgnSection"/);
  assert.match(html, /id="recentPgnList"/);
  assert.match(app, /chess-verse-recent-games-v1/);
  assert.match(app, /savePgnHistory\(parsedGame\)/);
  assert.match(app, /button\.dataset\.historyIndex/);
  assert.doesNotMatch(app, /recentPgnList\.innerHTML/);
});

test("production CSP permits local WebAssembly but not external scripts", () => {
  const flask = read("app/__init__.py");
  const vercel = read("vercel.json");
  for (const source of [flask, vercel]) {
    assert.match(source, /script-src 'self' 'wasm-unsafe-eval'/);
    assert.match(source, /object-src 'none'/);
    assert.doesNotMatch(source, /script-src[^;]*https:/);
  }
});

test("Gemini credentials and provider URLs do not appear in public files", () => {
  for (const file of ["index.html", "static/js/app.js", "static/js/coach-core.js", "static/js/coach-client.js"]) {
    assert.doesNotMatch(read(file), /GEMINI_API_KEY|x-goog-api-key|generativelanguage\.googleapis/i);
  }
});

test("AI Coach tab has locked, explicit-generate, live-status, and accessible tab states", () => {
  const html = read("index.html");
  assert.match(html, /id="tabCoachBtn"[^>]*role="tab"[^>]*aria-selected="false"/);
  assert.match(html, /Analyze a game to unlock AI Coach\./);
  assert.match(html, /id="generateCoachBtn"[^>]*>Generate AI Coach Review</);
  assert.match(html, /id="coachStatus"[^>]*role="status"/);
});

test("AI Coach mobile styles wrap content and retain touch targets", () => {
  const css = read("static/css/style.css");
  assert.match(css, /\.coach-report-section[\s\S]*overflow-wrap:\s*anywhere/);
  assert.match(css, /@media \(max-width: 480px\)[\s\S]*\.tab-btn/);
  assert.match(css, /@media \(pointer: coarse\)[\s\S]*min-height:\s*44px/);
});

test("desktop workspace is bounded with keyboard-accessible internal tab scrolling", () => {
  const html = read("index.html");
  const css = read("static/css/style.css");
  assert.match(html, /class="analysis-tab-viewport"/);
  for (const id of ["tabContentMoves", "tabContentInfo", "tabContentCoach"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*tabindex="0"`));
  }
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*\.main-grid\s*\{[\s\S]*height:/);
  assert.match(css, /\.analysis-tab-viewport\s*\{[\s\S]*flex:\s*1 1 auto/);
  assert.match(css, /overscroll-behavior:\s*contain/);
  assert.match(css, /scrollbar-gutter:\s*stable/);
});

test("mobile restores natural analysis flow and coach critical moments use semantic hierarchy", () => {
  const css = read("static/css/style.css");
  const coachClient = read("static/js/coach-client.js");
  assert.match(css, /@media \(max-width: 899px\)[\s\S]*\.analysis-tab-viewport,[\s\S]*\.tab-content\s*\{[\s\S]*overflow:\s*visible/);
  assert.match(coachClient, /coach-critical-meta/);
  assert.match(coachClient, /coach-classification-badge/);
  assert.match(coachClient, /criticalMoveReference\(moment\)/);
});
