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

test("legacy parser and worker-termination paths cannot reappear in app code", () => {
  const app = read("static/js/app.js");
  assert.doesNotMatch(app, /extractSanTokensFromPgn|normalizePgnDoubleNewline|terminateWorker/);
  assert.match(app, /core\.parsePgn/);
  assert.match(app, /engine\.startSession/);
  assert.doesNotMatch(app, /scrollIntoView/);
  assert.match(app, /moveLogEl\.scrollTop/);
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
