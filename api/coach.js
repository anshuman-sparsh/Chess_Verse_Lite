"use strict";

const crypto = require("node:crypto");
const core = require("../static/js/coach-core.js");
const { callGemini, ProviderError } = require("../lib/gemini-client.js");

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 5;
const requestWindows = new Map();

function json(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  return res.end(JSON.stringify(body));
}

function requestIp(req) {
  const forwarded = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "unknown";
}

function withinRateLimit(req, now = Date.now()) {
  if (requestWindows.size > 1000) {
    for (const [key, value] of requestWindows) {
      if (now - value.startedAt >= WINDOW_MS) requestWindows.delete(key);
    }
  }
  const ipHash = crypto.createHash("sha256").update(requestIp(req)).digest("hex").slice(0, 20);
  const current = requestWindows.get(ipHash);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    requestWindows.set(ipHash, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= MAX_REQUESTS_PER_WINDOW;
}

function readBody(req) {
  if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString("utf8"));
  if (typeof req.body === "string") return JSON.parse(req.body);
  return req.body;
}

function mapProviderError(error) {
  if (error.code === "not_configured" || error.code === "invalid_model") {
    return { status: 503, code: "coach_unavailable", message: "AI Coach is not configured yet." };
  }
  if (error.code === "timeout") return { status: 504, code: "provider_timeout", message: "AI Coach took too long. Please retry." };
  if (error.status === 429) return { status: 429, code: "rate_limited", message: "AI Coach is busy. Please wait and retry." };
  if (error.status === 503) return { status: 503, code: "provider_overloaded", message: "AI Coach is temporarily unavailable due to high demand. Please try again shortly." };
  if ([400, 401, 403].includes(error.status)) {
    return { status: 503, code: "coach_unavailable", message: "AI Coach is temporarily unavailable." };
  }
  return { status: 502, code: "provider_error", message: "AI Coach could not generate a valid review." };
}

function createCoachHandler(dependencies = {}) {
  const provider = dependencies.provider || callGemini;
  const rateLimit = dependencies.rateLimit || withinRateLimit;
  const env = dependencies.env || process.env;
  const logger = dependencies.logger || console;
  return async function handler(req, res) {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { ok: false, error: { code: "method_not_allowed", message: "Use POST for AI Coach." } });
    }
    if (!String(req.headers?.["content-type"] || "").toLowerCase().startsWith("application/json")) {
      return json(res, 415, { ok: false, error: { code: "unsupported_media_type", message: "AI Coach accepts JSON requests only." } });
    }
    const declaredLength = Number(req.headers?.["content-length"] || 0);
    if (declaredLength > core.MAX_REQUEST_BYTES) {
      return json(res, 413, { ok: false, error: { code: "request_too_large", message: "AI Coach request is too large." } });
    }
    if (!rateLimit(req)) {
      return json(res, 429, { ok: false, error: { code: "rate_limited", message: "Too many AI Coach requests. Please wait." } }, { "Retry-After": "60" });
    }

    let body;
    try {
      body = readBody(req);
      if (Buffer.byteLength(JSON.stringify(body || {}), "utf8") > core.MAX_REQUEST_BYTES) throw Object.assign(new Error("too large"), { tooLarge: true });
    } catch (error) {
      const status = error.tooLarge ? 413 : 400;
      return json(res, status, { ok: false, error: { code: status === 413 ? "request_too_large" : "invalid_json", message: status === 413 ? "AI Coach request is too large." : "Request body must be valid JSON." } });
    }

    let payload;
    try {
      payload = core.validatePayload(body);
      const expectedHash = crypto.createHash("sha256").update(core.canonicalGameString(payload.game)).digest("hex");
      if (expectedHash !== payload.gameHash) throw new Error("Game hash mismatch.");
    } catch (error) {
      return json(res, 400, { ok: false, error: { code: "invalid_payload", message: error.message || "Invalid AI Coach data." } });
    }

    try {
      const generated = await provider(payload, { env, logger });
      const report = core.validateCoachReport(generated.report, payload);
      return json(res, 200, {
        ok: true,
        schemaVersion: core.COACH_SCHEMA_VERSION,
        analysisVersion: core.ANALYSIS_SCHEMA_VERSION,
        gameHash: payload.gameHash,
        model: generated.model,
        report,
      });
    } catch (error) {
      if (error?.name === "ValidationError") {
        logger.error("AI Coach response validation failed:", error.message);
        return json(res, 502, { ok: false, error: { code: "invalid_provider_response", message: "AI Coach returned an unsupported review. Please retry." } });
      }
      const safe = mapProviderError(error instanceof ProviderError ? error : new ProviderError("unknown", error?.message || "Unknown provider error", 500));
      logger.error("AI Coach provider failure:", { code: error?.code, status: error?.status });
      return json(res, safe.status, { ok: false, error: { code: safe.code, message: safe.message } }, safe.status === 429 ? { "Retry-After": "60" } : {});
    }
  };
}

const handler = createCoachHandler();
module.exports = handler;
module.exports.createCoachHandler = createCoachHandler;
module.exports.mapProviderError = mapProviderError;
module.exports.withinRateLimit = withinRateLimit;
module.exports._requestWindows = requestWindows;
