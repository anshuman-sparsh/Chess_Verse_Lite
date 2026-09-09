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

test("AI Coach and Gemini code have not been introduced", () => {
  for (const file of ["index.html", "static/js/app.js", "static/js/analysis-core.js", "app/routes.py"]) {
    assert.doesNotMatch(read(file), /Gemini|AI Coach|generativelanguage\.googleapis/i);
  }
});
