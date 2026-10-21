import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  handleApiRequest,
  SECURITY_HEADERS,
  DEFAULT_ALLOWED_ORIGINS,
  isOriginAllowed,
  getAllowedOrigins,
  normalizeOrigin,
} from "../api/routes.ts";
import handler from "../../api/entry.ts";

function createMockReqRes(options: {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: any;
}) {
  const req: any = new EventEmitter();
  req.method = options.method || "GET";
  req.url = options.url;
  req.headers = options.headers || {};

  const res: any = new EventEmitter();
  let statusCode = 200;
  const headers: Record<string, string> = {};
  let responseData = "";

  res.statusCode = statusCode;
  res.headersSent = false;
  res.setHeader = (k: string, v: string) => {
    headers[k.toLowerCase()] = v;
  };
  res.writeHead = (code: number, hdrs?: Record<string, string>) => {
    statusCode = code;
    res.statusCode = code;
    if (hdrs) {
      Object.entries(hdrs).forEach(([k, v]) => {
        headers[k.toLowerCase()] = v;
      });
    }
  };
  res.end = (data?: string) => {
    if (data) responseData += data;
    res.emit("finish");
  };

  process.nextTick(() => {
    if (options.body !== undefined) {
      const payload =
        typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body);
      req.emit("data", Buffer.from(payload));
    }
    req.emit("end");
  });

  return {
    req: req as IncomingMessage,
    res: res as ServerResponse,
    getResult: () => ({
      status: res.statusCode || statusCode,
      headers,
      body: responseData ? JSON.parse(responseData) : null,
    }),
  };
}

// Helper to verify all 5 standard security headers on a result
function assertSecurityHeaders(headers: Record<string, string>, context = "") {
  assert.equal(
    headers["strict-transport-security"],
    "max-age=63072000; includeSubDomains; preload",
    `${context} Strict-Transport-Security must match standard`
  );
  assert.equal(
    headers["x-content-type-options"],
    "nosniff",
    `${context} X-Content-Type-Options must be nosniff`
  );
  assert.equal(
    headers["x-frame-options"],
    "DENY",
    `${context} X-Frame-Options must be DENY`
  );
  assert.equal(
    headers["referrer-policy"],
    "strict-origin-when-cross-origin",
    `${context} Referrer-Policy must be strict-origin-when-cross-origin`
  );
  assert.equal(
    headers["content-security-policy"],
    "default-src 'none'; frame-ancestors 'none'; sandbox",
    `${context} Content-Security-Policy must restrict API surfaces`
  );
}

// =========================================================================
// Dimension 1: Presence of Standard Security Headers on all Endpoints
// =========================================================================

test("Security Headers: GET /health returns all 5 standard security headers", async () => {
  const { req, res, getResult } = createMockReqRes({
    method: "GET",
    url: "/health",
  });
  const handled = await handleApiRequest(req, res);
  assert.equal(handled, true);
  const result = getResult();
  assert.equal(result.status, 200);
  assertSecurityHeaders(result.headers, "GET /health");
});

test("Security Headers: GET /v1/agents returns all 5 standard security headers", async () => {
  const { req, res, getResult } = createMockReqRes({
    method: "GET",
    url: "/v1/agents",
  });
  const handled = await handleApiRequest(req, res);
  assert.equal(handled, true);
  const result = getResult();
  assert.equal(result.status, 200);
  assertSecurityHeaders(result.headers, "GET /v1/agents");
});

test("Security Headers: GET /telegram/webhook returns all 5 standard security headers", async () => {
  const { req, res, getResult } = createMockReqRes({
    method: "GET",
    url: "/telegram/webhook",
  });
  const handled = await handleApiRequest(req, res);
  assert.equal(handled, true);
  const result = getResult();
  assert.equal(result.status, 200);
  assertSecurityHeaders(result.headers, "GET /telegram/webhook");
});

test("Security Headers: POST /v1/verify returns all 5 standard security headers on validation error", async () => {
  const { req, res, getResult } = createMockReqRes({
    method: "POST",
    url: "/v1/verify",
    body: {}, // empty body -> 400
  });
  const handled = await handleApiRequest(req, res);
  assert.equal(handled, true);
  const result = getResult();
  assert.equal(result.status, 400);
  assertSecurityHeaders(result.headers, "POST /v1/verify 400");
});

test("Security Headers: Vercel Gateway 404 returns all 5 standard security headers", async () => {
  const { req, res, getResult } = createMockReqRes({
    method: "GET",
    url: "/non-existent-api-route",
  });
  await handler(req, res);
  const result = getResult();
  assert.equal(result.status, 404);
  assertSecurityHeaders(result.headers, "Gateway 404");
});

// =========================================================================
// Dimension 2: Origin Handling & CORS Restriction
// =========================================================================

test("CORS: Trusted default origins receive Access-Control-Allow-Origin", async () => {
  for (const origin of DEFAULT_ALLOWED_ORIGINS) {
    const { req, res, getResult } = createMockReqRes({
      method: "GET",
      url: "/health",
      headers: { origin },
    });
    await handleApiRequest(req, res);
    const result = getResult();
    assert.equal(result.status, 200);
    assert.equal(
      result.headers["access-control-allow-origin"],
      origin,
      `Origin ${origin} should be reflected in Access-Control-Allow-Origin`
    );
    assert.equal(result.headers["vary"], "Origin");
    assert.equal(result.headers["access-control-allow-credentials"], "true");
    assertSecurityHeaders(result.headers);
  }
});

test("CORS: Untrusted origin is blocked (no Access-Control-Allow-Origin header)", async () => {
  const untrustedOrigins = [
    "https://evil-hacker.com",
    "https://phishing-site.org",
    "http://random-domain.xyz",
  ];

  for (const origin of untrustedOrigins) {
    const { req, res, getResult } = createMockReqRes({
      method: "GET",
      url: "/health",
      headers: { origin },
    });
    await handleApiRequest(req, res);
    const result = getResult();
    assert.equal(result.status, 200);
    assert.equal(
      result.headers["access-control-allow-origin"],
      undefined,
      `Untrusted origin ${origin} must NOT receive Access-Control-Allow-Origin`
    );
    assert.equal(result.headers["vary"], "Origin");
    assertSecurityHeaders(result.headers);
  }
});

test("CORS: Request without Origin header does not set Access-Control-Allow-Origin", async () => {
  const { req, res, getResult } = createMockReqRes({
    method: "GET",
    url: "/health",
  });
  await handleApiRequest(req, res);
  const result = getResult();
  assert.equal(result.status, 200);
  assert.equal(result.headers["access-control-allow-origin"], undefined);
  assert.equal(result.headers["vary"], "Origin");
  assertSecurityHeaders(result.headers);
});

test("CORS: Custom ALLOWED_ORIGINS environment variable overrides defaults strictly", async () => {
  const origEnv = process.env.ALLOWED_ORIGINS;
  try {
    process.env.ALLOWED_ORIGINS =
      "https://enterprise.vera.os, https://client.custom-domain.com";

    // Allowed custom origin
    const { req: req1, res: res1, getResult: getResult1 } = createMockReqRes({
      method: "GET",
      url: "/health",
      headers: { origin: "https://enterprise.vera.os" },
    });
    await handleApiRequest(req1, res1);
    assert.equal(
      getResult1().headers["access-control-allow-origin"],
      "https://enterprise.vera.os"
    );

    // Previously default origin localhost is now blocked because env strictly defines allowed list
    const { req: req2, res: res2, getResult: getResult2 } = createMockReqRes({
      method: "GET",
      url: "/health",
      headers: { origin: "http://localhost:3000" },
    });
    await handleApiRequest(req2, res2);
    assert.equal(
      getResult2().headers["access-control-allow-origin"],
      undefined,
      "Default localhost should not be allowed when custom ALLOWED_ORIGINS excludes it"
    );
  } finally {
    if (origEnv !== undefined) {
      process.env.ALLOWED_ORIGINS = origEnv;
    } else {
      delete process.env.ALLOWED_ORIGINS;
    }
  }
});

// =========================================================================
// Dimension 3: Preflight OPTIONS Requests & Caching
// =========================================================================

test("Preflight: OPTIONS /v1/verify with trusted Origin returns 204 with caching and methods", async () => {
  const { req, res, getResult } = createMockReqRes({
    method: "OPTIONS",
    url: "/v1/verify",
    headers: {
      origin: "http://localhost:5173",
      "access-control-request-method": "POST",
      "access-control-request-headers": "Content-Type, Authorization",
    },
  });
  const handled = await handleApiRequest(req, res);
  assert.equal(handled, true);
  const result = getResult();
  assert.equal(result.status, 204);
  assert.equal(
    result.headers["access-control-allow-origin"],
    "http://localhost:5173"
  );
  assert.equal(result.headers["access-control-max-age"], "86400");
  assert.ok(
    result.headers["access-control-allow-methods"].includes("GET") &&
      result.headers["access-control-allow-methods"].includes("POST") &&
      result.headers["access-control-allow-methods"].includes("OPTIONS")
  );
  assert.ok(
    result.headers["access-control-allow-headers"].includes("Content-Type") &&
      result.headers["access-control-allow-headers"].includes("Authorization")
  );
  assertSecurityHeaders(result.headers, "Preflight OPTIONS 204");
});

test("Preflight: OPTIONS with untrusted origin does not receive Access-Control-Allow-Origin", async () => {
  const { req, res, getResult } = createMockReqRes({
    method: "OPTIONS",
    url: "/v1/verify",
    headers: {
      origin: "https://attacker.site",
      "access-control-request-method": "POST",
    },
  });
  const handled = await handleApiRequest(req, res);
  assert.equal(handled, true);
  const result = getResult();
  assert.equal(result.status, 204);
  assert.equal(result.headers["access-control-allow-origin"], undefined);
  assertSecurityHeaders(result.headers, "Untrusted Preflight OPTIONS");
});

// =========================================================================
// Dimension 4: Negative & Spoofing Tests
// =========================================================================

test("Security & Anti-Spoofing: Subdomain suffix attack is rejected", () => {
  assert.equal(isOriginAllowed("http://localhost:3000.evil.com"), false);
  assert.equal(isOriginAllowed("https://vera-os.vercel.app.evil.com"), false);
});

test("Security & Anti-Spoofing: Prefix prepend attack is rejected", () => {
  assert.equal(isOriginAllowed("http://fakelocalhost:3000"), false);
  assert.equal(isOriginAllowed("https://fakevera-os.vercel.app"), false);
});

test("Security & Anti-Spoofing: Port alteration attack is rejected", () => {
  assert.equal(isOriginAllowed("http://localhost:8080"), false);
  assert.equal(isOriginAllowed("http://localhost:9999"), false);
  assert.equal(isOriginAllowed("http://127.0.0.1:8080"), false);
});

test("Security & Anti-Spoofing: Protocol downgrade/mismatch is rejected", () => {
  assert.equal(isOriginAllowed("https://localhost:3000"), false);
  assert.equal(isOriginAllowed("http://vera-os.vercel.app"), false);
});

test("Security & Anti-Spoofing: Null origin and file URI scheme are rejected", () => {
  assert.equal(isOriginAllowed("null"), false);
  assert.equal(isOriginAllowed("file://"), false);
  assert.equal(isOriginAllowed(""), false);
});

test("Security & Anti-Spoofing: Trailing slash in origin is normalized safely", () => {
  assert.equal(normalizeOrigin("http://localhost:3000/"), "http://localhost:3000");
  assert.equal(isOriginAllowed("http://localhost:3000/"), true);
});

test("Security & Anti-Spoofing: Wildcard support when explicitly enabled in env", () => {
  const orig = process.env.ALLOWED_ORIGINS;
  try {
    process.env.ALLOWED_ORIGINS = "*";
    assert.equal(isOriginAllowed("https://any-domain.com"), true);
    assert.equal(isOriginAllowed("http://random.org"), true);
  } finally {
    if (orig !== undefined) {
      process.env.ALLOWED_ORIGINS = orig;
    } else {
      delete process.env.ALLOWED_ORIGINS;
    }
  }
});
