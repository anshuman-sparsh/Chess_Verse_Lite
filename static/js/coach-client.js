(function (root, factory) {
  const dependency = typeof module === "object" && module.exports
    ? require("./coach-core.js")
    : root.ChessVerseCoachCore;
  const api = factory(dependency);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ChessVerseCoach = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (core) {
  "use strict";

  const CACHE_DB = "chess-verse-ai-coach";
  const CACHE_STORE = "reports";
  const CACHE_DB_VERSION = 1;
  const CLIENT_COOLDOWN_MS = 3000;
  const CLIENT_TIMEOUT_MS = 30000;

  function cacheKey(payload) {
    return `${payload.gameHash}:analysis-${payload.analysisVersion}:coach-${payload.schemaVersion}`;
  }

  function createMemoryCache() {
    const values = new Map();
    return {
      async get(key) { return values.get(key) || null; },
      async set(key, value) { values.set(key, value); },
      async delete(key) { values.delete(key); },
    };
  }

  function createIndexedDbCache(indexedDb = globalThis.indexedDB) {
    if (!indexedDb) return createMemoryCache();
    const fallback = createMemoryCache();
    let failed = false;
    let openPromise = null;
    const open = () => {
      if (openPromise) return openPromise;
      openPromise = new Promise((resolve, reject) => {
        const request = indexedDb.open(CACHE_DB, CACHE_DB_VERSION);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(CACHE_STORE)) request.result.createObjectStore(CACHE_STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("AI Coach cache could not open."));
      });
      return openPromise;
    };
    const transact = async (mode, operation) => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(CACHE_STORE, mode);
        const request = operation(transaction.objectStore(CACHE_STORE));
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error || new Error("AI Coach cache operation failed."));
      });
    };
    const safely = async (primary, secondary) => {
      if (failed) return secondary();
      try { return await primary(); }
      catch (_) {
        failed = true;
        return secondary();
      }
    };
    return {
      get: (key) => safely(() => transact("readonly", (store) => store.get(key)), () => fallback.get(key)),
      set: (key, value) => safely(() => transact("readwrite", (store) => store.put(value, key)), () => fallback.set(key, value)),
      delete: (key) => safely(() => transact("readwrite", (store) => store.delete(key)), () => fallback.delete(key)),
    };
  }

  class CoachRequestManager {
    constructor(options = {}) {
      this.fetchImpl = options.fetchImpl || globalThis.fetch?.bind(globalThis);
      this.cache = options.cache || createIndexedDbCache(options.indexedDB);
      this.now = options.now || Date.now;
      this.cooldownMs = options.cooldownMs ?? CLIENT_COOLDOWN_MS;
      this.timeoutMs = options.timeoutMs ?? CLIENT_TIMEOUT_MS;
      this.active = null;
      this.lastStartedAt = -Infinity;
    }

    async getCached(payload) {
      const key = cacheKey(payload);
      const value = await this.cache.get(key);
      if (!value) return null;
      try {
        return core.validateCoachReport(value, payload);
      } catch (_) {
        await this.cache.delete(key);
        return null;
      }
    }

    generate(payload) {
      const key = cacheKey(payload);
      if (this.active) {
        if (this.active.key === key) return this.active.promise;
        const error = new Error("Another AI Coach review is still generating. Please wait.");
        error.code = "generation_in_progress";
        return Promise.reject(error);
      }
      const promise = this._generate(payload).finally(() => {
        if (this.active?.promise === promise) this.active = null;
      });
      this.active = { key, promise };
      return promise;
    }

    async _generate(payload) {
      const cached = await this.getCached(payload);
      if (cached) return { report: cached, cached: true };
      if (this.now() - this.lastStartedAt < this.cooldownMs) {
        const error = new Error("Please wait a moment before retrying AI Coach.");
        error.code = "cooldown";
        throw error;
      }
      this.lastStartedAt = this.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl("/api/coach", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        let data = null;
        try { data = await response.json(); } catch (_) {}
        if (!response.ok || !data?.ok) {
          const error = new Error(data?.error?.message || "AI Coach could not generate a review.");
          error.code = data?.error?.code || `http_${response.status}`;
          error.status = response.status;
          throw error;
        }
        if (data.gameHash !== payload.gameHash || data.schemaVersion !== payload.schemaVersion || data.analysisVersion !== payload.analysisVersion) {
          throw new Error("AI Coach returned data for a different analysis.");
        }
        const report = core.validateCoachReport(data.report, payload);
        await this.cache.set(cacheKey(payload), report);
        return { report, cached: false };
      } catch (error) {
        if (error?.name === "AbortError") {
          const timeoutError = new Error("AI Coach took too long. Please retry.");
          timeoutError.code = "timeout";
          throw timeoutError;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  function appendEvidenceList(container, items, emptyText) {
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "coach-muted";
      empty.textContent = emptyText;
      container.appendChild(empty);
      return;
    }
    const list = document.createElement("ul");
    list.className = "coach-list";
    for (const item of items) {
      const li = document.createElement("li");
      li.textContent = humanizeCoachText(item.text);
      list.appendChild(li);
    }
    container.appendChild(list);
  }

  function humanizeCoachText(value) {
    return String(value || "").replace(/\bplies\b/gi, "moves").replace(/\bply\b/gi, "move");
  }

  function criticalMoveReference(moment) {
    const ply = Number(moment?.ply);
    const moveNumber = Number.isInteger(moment?.moveNumber) && moment.moveNumber > 0
      ? moment.moveNumber
      : Math.ceil(ply / 2);
    const isBlack = moment?.side === "black" || (!moment?.side && Number.isInteger(ply) && ply % 2 === 0);
    const suffix = isBlack ? "..." : ".";
    const san = typeof moment?.san === "string" ? moment.san.trim() : "";
    return san ? `${moveNumber}${suffix}${san}` : `Move ${moveNumber}${suffix}`;
  }

  function section(reportRoot, title) {
    const element = document.createElement("section");
    element.className = `coach-report-section coach-section-${title.toLowerCase().replace(/[^a-z]+/g, "-").replace(/(^-|-$)/g, "")}`;
    const heading = document.createElement("h3");
    heading.textContent = title;
    element.appendChild(heading);
    reportRoot.appendChild(element);
    return element;
  }

  function renderReport(root, report) {
    root.replaceChildren();
    const overall = section(root, "Overall Review");
    const overallText = document.createElement("p");
    overallText.textContent = humanizeCoachText(report.overallReview.text);
    overall.appendChild(overallText);

    appendEvidenceList(section(root, "Strengths"), report.strengths, "No specific strength had enough engine evidence to call out.");
    appendEvidenceList(section(root, "Areas to Improve"), report.areasToImprove, "No recurring weakness was strongly supported by this game.");

    const critical = section(root, "Critical Moments");
    if (!report.criticalMoments.length) {
      const text = document.createElement("p");
      text.className = "coach-muted";
      text.textContent = "No major critical moment was identified.";
      critical.appendChild(text);
    }
    for (const moment of report.criticalMoments) {
      const card = document.createElement("article");
      card.className = "coach-critical-card";
      const meta = document.createElement("div");
      meta.className = "coach-critical-meta";
      const notation = document.createElement("strong");
      notation.className = "coach-critical-notation";
      notation.textContent = criticalMoveReference(moment);
      const badge = document.createElement("span");
      badge.className = `coach-classification-badge coach-classification-${moment.classification}`;
      badge.textContent = moment.classification;
      meta.append(notation, badge);
      card.appendChild(meta);
      const heading = document.createElement("h4");
      heading.textContent = humanizeCoachText(moment.title);
      card.appendChild(heading);
      const changed = document.createElement("p");
      changed.textContent = humanizeCoachText(moment.whatChanged);
      card.appendChild(changed);
      const mattered = document.createElement("p");
      mattered.textContent = humanizeCoachText(moment.whyItMattered);
      card.appendChild(mattered);
      if (moment.preferredMove) {
        const best = document.createElement("div");
        best.className = "coach-preferred-move";
        const bestLabel = document.createElement("span");
        bestLabel.textContent = "Stockfish preferred";
        const bestValue = document.createElement("strong");
        bestValue.textContent = moment.preferredMove;
        best.append(bestLabel, bestValue);
        card.appendChild(best);
      }
      critical.appendChild(card);
    }

    appendEvidenceList(section(root, "Training Recommendations"), report.trainingRecommendations, "Keep reviewing games for a larger training sample.");

    if (report.phaseAssessment?.length) {
      const phases = section(root, "Phase Assessment");
      for (const phase of report.phaseAssessment) {
        const card = document.createElement("div");
        card.className = "coach-phase-row";
        const label = document.createElement("strong");
        label.textContent = `${phase.side} ${phase.phase}: ${phase.rating}`;
        const text = document.createElement("span");
        text.textContent = humanizeCoachText(phase.text);
        card.append(label, text);
        phases.appendChild(card);
      }
    }

    const takeaway = section(root, "One-Line Takeaway");
    const takeawayText = document.createElement("p");
    takeawayText.className = "coach-takeaway";
    takeawayText.textContent = humanizeCoachText(report.oneLineTakeaway.text);
    takeaway.appendChild(takeawayText);
  }

  let ui = null;

  function initializeUi() {
    if (typeof document === "undefined") return null;
    const root = document.getElementById("coachPanel");
    const locked = document.getElementById("coachLockedState");
    const ready = document.getElementById("coachReadyState");
    const generate = document.getElementById("generateCoachBtn");
    const status = document.getElementById("coachStatus");
    const report = document.getElementById("coachReport");
    if (!root || !locked || !ready || !generate || !status || !report) return null;
    const manager = new CoachRequestManager();
    let payload = null;
    let stateToken = 0;

    const setState = (state, message = "") => {
      locked.hidden = state !== "locked";
      ready.hidden = !["ready", "loading", "error"].includes(state);
      report.hidden = state !== "report";
      generate.hidden = state === "report";
      generate.disabled = state === "loading";
      generate.textContent = state === "loading" ? "Generating AI Coach Review..." : "Generate AI Coach Review";
      status.textContent = message;
      status.classList.toggle("coach-error", state === "error");
      root.setAttribute("aria-busy", String(state === "loading"));
    };

    generate.addEventListener("click", async () => {
      if (!payload || generate.disabled) return;
      const requestPayload = payload;
      setState("loading", "Generating AI Coach Review...");
      const busyTimer = setTimeout(() => {
        if (payload === requestPayload && generate.disabled) status.textContent = "AI Coach is temporarily busy. Retrying...";
      }, 700);
      try {
        const result = await manager.generate(requestPayload);
        if (payload !== requestPayload) return;
        renderReport(report, result.report);
        setState("report");
        report.hidden = false;
        status.textContent = result.cached ? "Loaded saved review." : "AI Coach review ready.";
      } catch (error) {
        if (payload !== requestPayload) return;
        setState("error", error?.message || "AI Coach could not generate a review. Please retry.");
      } finally {
        clearTimeout(busyTimer);
      }
    });

    ui = {
      clearAnalysis() {
        stateToken += 1;
        payload = null;
        report.replaceChildren();
        setState("locked");
      },
      async setAnalysis(parsedGame, analysis) {
        const token = ++stateToken;
        payload = null;
        report.replaceChildren();
        setState("loading", "Preparing AI Coach data...");
        try {
          const prepared = await core.buildCoachPayload(parsedGame, analysis);
          if (token !== stateToken) return;
          payload = prepared;
          const cached = await manager.getCached(prepared);
          if (token !== stateToken) return;
          if (cached) {
            renderReport(report, cached);
            setState("report");
            report.hidden = false;
            status.textContent = "Loaded saved review.";
          } else {
            setState("ready", "Stockfish analysis is ready for coaching.");
          }
        } catch (error) {
          if (token !== stateToken) return;
          setState("error", error?.message || "AI Coach data could not be prepared.");
        }
      },
    };
    ui.clearAnalysis();
    return ui;
  }

  if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", initializeUi);

  return {
    cacheKey,
    createMemoryCache,
    createIndexedDbCache,
    CoachRequestManager,
    criticalMoveReference,
    humanizeCoachText,
    renderReport,
    initializeUi,
    clearAnalysis: () => ui?.clearAnalysis(),
    setAnalysis: (parsedGame, analysis) => ui?.setAnalysis(parsedGame, analysis),
  };
});
