(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ChessVerseEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function abortError(message) {
    const error = new Error(message || "Analysis canceled.");
    error.name = "AbortError";
    return error;
  }

  class BrowserStockfish {
    constructor(options = {}) {
      this.workerFactory = options.workerFactory || ((path) => new Worker(path));
      this.workerPaths = options.workerPaths || ["static/js/stockfish.wasm.js", "static/js/stockfish.js"];
      this.ChessCtor = options.ChessCtor || null;
      this.readyTimeoutMs = options.readyTimeoutMs || 15000;
      this.searchTimeoutMs = options.searchTimeoutMs || 45000;
      this.stopTimeoutMs = options.stopTimeoutMs || 1500;
      this.worker = null;
      this.ready = false;
      this.initPromise = null;
      this.initResolve = null;
      this.initReject = null;
      this.initTimer = null;
      this.jobs = [];
      this.active = null;
      this.sessionId = 0;
    }

    startSession(reason = "Analysis superseded.") {
      this.sessionId += 1;
      this.cancelPending(reason);
      return this.sessionId;
    }

    isCurrentSession(sessionId) {
      return sessionId === this.sessionId;
    }

    cancelPending(reason = "Analysis canceled.") {
      const error = abortError(reason);
      for (const job of this.jobs.splice(0)) this._rejectJob(job, error);
      if (!this.active) return;

      this.active.canceled = true;
      this._rejectJob(this.active, error);
      const stoppedJob = this.active;
      try {
        this.worker?.postMessage("stop");
      } catch (_) {
        this._restartAfterStopFailure(stoppedJob);
        return;
      }
      clearTimeout(stoppedJob.stopTimer);
      stoppedJob.stopTimer = setTimeout(() => this._restartAfterStopFailure(stoppedJob), this.stopTimeoutMs);
    }

    async ensureReady() {
      if (this.ready && this.worker) return;
      if (this.initPromise) return this.initPromise;

      this.initPromise = (async () => {
        let lastError = null;
        for (const path of this.workerPaths) {
          try {
            await this._initializePath(path);
            return;
          } catch (error) {
            lastError = error;
            this._disposeWorker();
          }
        }
        throw lastError || new Error("Unable to initialize Stockfish.");
      })();

      try {
        await this.initPromise;
      } finally {
        this.initPromise = null;
      }
    }

    _initializePath(path) {
      return new Promise((resolve, reject) => {
        let worker;
        try {
          worker = this.workerFactory(path);
        } catch (error) {
          reject(error);
          return;
        }

        this.worker = worker;
        this.ready = false;
        this.initResolve = resolve;
        this.initReject = reject;
        worker.addEventListener("message", (event) => this._handleMessage(event));
        worker.addEventListener("error", (event) => this._handleWorkerError(event));
        worker.addEventListener("messageerror", (event) => this._handleWorkerError(event));
        this.initTimer = setTimeout(() => {
          this.initReject?.(new Error("Stockfish readiness timed out."));
          this._clearInitState();
        }, this.readyTimeoutMs);
        worker.postMessage("uci");
      });
    }

    _handleMessage(event) {
      const line = String(event.data || "").trim();
      if (line === "uciok" && !this.ready) {
        this.worker?.postMessage("setoption name MultiPV value 1");
        this.worker?.postMessage("isready");
        return;
      }
      if (line === "readyok" && !this.ready) {
        this.ready = true;
        const resolve = this.initResolve;
        this._clearInitState();
        resolve?.();
        return;
      }
      if (!this.ready) return;
      if (!this.active) return;
      if (line.startsWith("info ")) this._consumeInfo(line, this.active);
      else if (line.startsWith("bestmove")) this._completeActive(line);
    }

    _consumeInfo(line, job) {
      const parts = line.split(/\s+/);
      if (parts.includes("lowerbound") || parts.includes("upperbound")) return;
      const multipvIndex = parts.indexOf("multipv");
      if (multipvIndex >= 0 && Number(parts[multipvIndex + 1]) !== 1) return;
      const depthIndex = parts.indexOf("depth");
      const depth = depthIndex >= 0 ? Number(parts[depthIndex + 1]) : 0;
      if (depth < job.lastInfo.depth) return;

      const scoreIndex = parts.indexOf("score");
      if (scoreIndex >= 0) {
        const type = parts[scoreIndex + 1];
        const value = Number(parts[scoreIndex + 2]);
        if (Number.isFinite(value)) {
          if (type === "cp") {
            job.lastInfo.score = {
              type: "cp",
              whitePovCp: job.whiteToMove ? value : -value,
            };
          } else if (type === "mate") {
            const whitePovMate = job.whiteToMove ? value : -value;
            job.lastInfo.score = {
              type: "mate",
              winner: whitePovMate >= 0 ? "white" : "black",
              moves: Math.abs(value),
            };
          }
        }
      }
      const pvIndex = parts.indexOf("pv");
      if (pvIndex >= 0) job.lastInfo.pvUci = parts.slice(pvIndex + 1);
      job.lastInfo.depth = depth;
    }

    _completeActive(line) {
      const job = this.active;
      if (!job) return;
      clearTimeout(job.searchTimer);
      clearTimeout(job.stopTimer);
      this.active = null;
      const bestMoveUci = line.split(/\s+/)[1];

      if (!job.canceled && job.sessionId === this.sessionId) {
        this._resolveJob(job, {
          score: job.lastInfo.score,
          bestMoveUci: bestMoveUci && !bestMoveUci.startsWith("(") ? bestMoveUci : null,
          pvUci: job.lastInfo.pvUci,
          depth: job.lastInfo.depth,
        });
      } else {
        this._rejectJob(job, abortError());
      }
      this._pump();
    }

    _handleWorkerError(event) {
      const error = event instanceof Error ? event : new Error(event?.message || "Stockfish worker failed.");
      if (this.initReject) {
        const rejectInitialization = this.initReject;
        this._clearInitState();
        this._disposeWorker();
        rejectInitialization(error);
        return;
      }
      if (this.active) {
        clearTimeout(this.active.searchTimer);
        clearTimeout(this.active.stopTimer);
        this._rejectJob(this.active, error);
      }
      this.active = null;
      this._disposeWorker();
      this._pump();
    }

    _clearInitState() {
      clearTimeout(this.initTimer);
      this.initTimer = null;
      this.initResolve = null;
      this.initReject = null;
    }

    _disposeWorker() {
      try { this.worker?.terminate(); } catch (_) {}
      this.worker = null;
      this.ready = false;
      this._clearInitState();
    }

    _restartAfterStopFailure(expectedJob) {
      if (expectedJob && this.active !== expectedJob) return;
      const job = this.active;
      if (job) {
        clearTimeout(job.searchTimer);
        clearTimeout(job.stopTimer);
        this._rejectJob(job, abortError());
      }
      this.active = null;
      this._disposeWorker();
      this._pump();
    }

    _resolveJob(job, value) {
      if (job.settled) return;
      job.settled = true;
      job.resolve(value);
    }

    _rejectJob(job, error) {
      if (job.settled) return;
      job.settled = true;
      job.reject(error);
    }

    _terminalResult(fen) {
      if (!this.ChessCtor) return null;
      try {
        const board = new this.ChessCtor(fen);
        if (!board.game_over()) return null;
        if (board.in_checkmate()) {
          return {
            score: { type: "mate", winner: board.turn() === "w" ? "black" : "white", moves: 0 },
            bestMoveUci: null,
            pvUci: [],
            depth: 0,
          };
        }
        return {
          score: { type: "terminal", result: "draw" },
          bestMoveUci: null,
          pvUci: [],
          depth: 0,
        };
      } catch (_) {
        return null;
      }
    }

    analyzePosition(fen, depth = 14, options = {}) {
      const terminal = this._terminalResult(fen);
      if (terminal) return Promise.resolve(terminal);
      const sessionId = options.sessionId ?? this.sessionId;
      return new Promise((resolve, reject) => {
        const job = {
          fen,
          depth,
          sessionId,
          resolve,
          reject,
          settled: false,
          canceled: false,
          whiteToMove: fen.split(/\s+/)[1] === "w",
          lastInfo: { score: { type: "cp", whitePovCp: 0 }, pvUci: [], depth: 0 },
          searchTimer: null,
          stopTimer: null,
        };
        if (sessionId !== this.sessionId) {
          this._rejectJob(job, abortError());
          return;
        }
        this.jobs.push(job);
        this._pump();
      });
    }

    async _pump() {
      if (this.active) return;
      const job = this.jobs.shift();
      if (!job) return;
      if (job.sessionId !== this.sessionId || job.canceled) {
        this._rejectJob(job, abortError());
        this._pump();
        return;
      }

      // Reserve the active slot before initialization so cancellation rejects the
      // caller immediately even when WASM startup is still in progress.
      this.active = job;
      try {
        await this.ensureReady();
      } catch (error) {
        this._rejectJob(job, error);
        if (this.active === job) this.active = null;
        this._pump();
        return;
      }
      if (this.active !== job || job.sessionId !== this.sessionId || job.canceled) {
        clearTimeout(job.stopTimer);
        this._rejectJob(job, abortError());
        if (this.active === job) this.active = null;
        this._pump();
        return;
      }

      job.searchTimer = setTimeout(() => {
        job.canceled = true;
        this._rejectJob(job, new Error("Stockfish search timed out."));
        try { this.worker?.postMessage("stop"); } catch (_) {}
        job.stopTimer = setTimeout(() => this._restartAfterStopFailure(job), this.stopTimeoutMs);
      }, this.searchTimeoutMs);
      this.worker.postMessage(`position fen ${job.fen}`);
      this.worker.postMessage(`go depth ${job.depth}`);
    }

    destroy() {
      this.sessionId += 1;
      this.cancelPending("Engine destroyed.");
      if (this.active) {
        clearTimeout(this.active.searchTimer);
        clearTimeout(this.active.stopTimer);
      }
      this._disposeWorker();
      this.active = null;
    }
  }

  return { BrowserStockfish, abortError };
});
