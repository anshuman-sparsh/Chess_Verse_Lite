const test = require("node:test");
const assert = require("node:assert/strict");
const { BrowserStockfish } = require("../static/js/stockfish-controller.js");
const { Chess } = require("../static/js/chess.min.js");

class FakeWorker {
  constructor(onCommand) {
    this.onCommand = onCommand;
    this.listeners = { message: [], error: [], messageerror: [] };
    this.commands = [];
    this.terminated = false;
  }
  addEventListener(type, listener) { this.listeners[type].push(listener); }
  postMessage(command) {
    this.commands.push(command);
    this.onCommand?.(command, this);
  }
  emit(data) { for (const listener of this.listeners.message) listener({ data }); }
  fail(message) { for (const listener of this.listeners.error) listener({ message }); }
  terminate() { this.terminated = true; }
}

function readyWorker(searchHandler) {
  return new FakeWorker((command, worker) => {
    if (command === "uci") queueMicrotask(() => worker.emit("uciok"));
    else if (command === "isready") queueMicrotask(() => worker.emit("readyok"));
    else searchHandler?.(command, worker);
  });
}

test("UCI handshake completes before a search and the worker is reused", async () => {
  let creations = 0;
  const worker = readyWorker((command, instance) => {
    if (command.startsWith("go ")) queueMicrotask(() => {
      instance.emit("info depth 14 score cp 35 pv e2e4 e7e5");
      instance.emit("bestmove e2e4");
    });
  });
  const engine = new BrowserStockfish({ workerFactory: () => { creations += 1; return worker; }, workerPaths: ["fake"] });
  const session = engine.startSession();
  const first = await engine.analyzePosition("8/8/8/8/8/8/8/K6k w - - 0 1", 14, { sessionId: session });
  const second = await engine.analyzePosition("8/8/8/8/8/8/8/K6k b - - 0 1", 14, { sessionId: session });
  assert.equal(creations, 1);
  assert.equal(first.score.whitePovCp, 35);
  assert.equal(second.score.whitePovCp, -35);
  assert.ok(worker.commands.indexOf("uci") < worker.commands.indexOf("isready"));
  assert.ok(worker.commands.indexOf("isready") < worker.commands.findIndex((value) => value.startsWith("position fen")));
  engine.destroy();
});

test("worker initialization falls back to the next bundled engine path", async () => {
  const paths = [];
  const engine = new BrowserStockfish({
    workerPaths: ["wasm", "javascript"],
    workerFactory: (path) => {
      paths.push(path);
      if (path === "wasm") {
        return new FakeWorker((command, worker) => {
          if (command === "uci") queueMicrotask(() => worker.fail("WASM unavailable"));
        });
      }
      return readyWorker((command, worker) => {
        if (command.startsWith("go ")) queueMicrotask(() => worker.emit("bestmove e2e4"));
      });
    },
  });
  const session = engine.startSession();
  const result = await engine.analyzePosition("8/8/8/8/8/8/8/K6k w - - 0 1", 10, { sessionId: session });
  assert.deepEqual(paths, ["wasm", "javascript"]);
  assert.equal(result.bestMoveUci, "e2e4");
  engine.destroy();
});

test("mode switching or reset rejects active work and stale worker output cannot resolve it", async () => {
  let searches = 0;
  const worker = readyWorker((command, instance) => {
    if (command.startsWith("go ")) {
      searches += 1;
      if (searches === 2) queueMicrotask(() => {
        instance.emit("info depth 14 score cp 80 pv d2d4");
        instance.emit("bestmove d2d4");
      });
    } else if (command === "stop") {
      queueMicrotask(() => {
        instance.emit("info depth 14 score cp 999 pv a2a3");
        instance.emit("bestmove a2a3");
      });
    }
  });
  const engine = new BrowserStockfish({ workerFactory: () => worker, workerPaths: ["fake"], stopTimeoutMs: 50 });
  const oldSession = engine.startSession();
  const oldRequest = engine.analyzePosition("8/8/8/8/8/8/8/K6k w - - 0 1", 14, { sessionId: oldSession });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const newSession = engine.startSession("Mode changed.");
  const newRequest = engine.analyzePosition("8/8/8/8/8/8/8/K6k w - - 0 1", 14, { sessionId: newSession });
  await assert.rejects(oldRequest, { name: "AbortError" });
  const result = await newRequest;
  assert.equal(result.bestMoveUci, "d2d4");
  assert.equal(result.score.whitePovCp, 80);
  engine.destroy();
});

test("cancellation during worker startup rejects immediately", async () => {
  const worker = new FakeWorker(() => {});
  const engine = new BrowserStockfish({ workerFactory: () => worker, workerPaths: ["fake"], readyTimeoutMs: 5000, stopTimeoutMs: 10 });
  const session = engine.startSession();
  const request = engine.analyzePosition("8/8/8/8/8/8/8/K6k w - - 0 1", 14, { sessionId: session });
  await new Promise((resolve) => setTimeout(resolve, 0));
  engine.startSession("Reset.");
  await assert.rejects(request, { name: "AbortError" });
  engine.destroy();
});

test("search timeout rejects and a missing bestmove forces safe worker restart", async () => {
  const workers = [];
  const engine = new BrowserStockfish({
    workerFactory: () => {
      const worker = readyWorker();
      workers.push(worker);
      return worker;
    },
    workerPaths: ["fake"],
    searchTimeoutMs: 10,
    stopTimeoutMs: 10,
  });
  const session = engine.startSession();
  await assert.rejects(engine.analyzePosition("8/8/8/8/8/8/8/K6k w - - 0 1", 14, { sessionId: session }), /timed out/i);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(workers[0].terminated, true);
  engine.destroy();
});

test("checkmate and stalemate return tagged terminal scores without starting a worker", async () => {
  let creations = 0;
  const engine = new BrowserStockfish({ ChessCtor: Chess, workerFactory: () => { creations += 1; return readyWorker(); } });
  const mate = await engine.analyzePosition("rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3");
  const stalemate = await engine.analyzePosition("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1");
  assert.deepEqual(mate.score, { type: "mate", winner: "black", moves: 0 });
  assert.deepEqual(stalemate.score, { type: "terminal", result: "draw" });
  assert.equal(creations, 0);
  engine.destroy();
});
