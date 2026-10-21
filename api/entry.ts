import type { IncomingMessage, ServerResponse } from "node:http";
import { handleApiRequest, sendJson } from "../server/api/routes.ts";

function resolveTargetUrl(req: IncomingMessage): string {
  // 1. If x-matched-path header exists (Vercel edge proxy provides this)
  const matchedPath = req.headers["x-matched-path"] as string | undefined;
  if (
    matchedPath &&
    (matchedPath.startsWith("/v1") ||
      matchedPath.startsWith("/health") ||
      matchedPath.startsWith("/telegram"))
  ) {
    const rawReqUrl = req.url || "";
    const queryIdx = rawReqUrl.indexOf("?");
    const queryStr = queryIdx !== -1 ? rawReqUrl.slice(queryIdx) : "";
    return `${matchedPath}${queryStr}`;
  }

  // 2. If 'url' parameter is passed via vercel.json rewrite
  try {
    const parsed = new URL(req.url || "/", "http://localhost");
    const rewrittenUrl =
      parsed.searchParams.get("url") || parsed.searchParams.get("__url");
    if (rewrittenUrl) {
      parsed.searchParams.delete("url");
      parsed.searchParams.delete("__url");
      const remainingQuery = parsed.searchParams.toString();
      const baseRewritten = rewrittenUrl.split("?")[0];
      return remainingQuery ? `${baseRewritten}?${remainingQuery}` : rewrittenUrl;
    }
  } catch {
    // fallback
  }

  // 3. If req.url starts with /api/v1, /api/health, or /api/telegram, strip the /api prefix
  const rawUrl = req.url || "/";
  if (
    rawUrl.startsWith("/api/v1") ||
    rawUrl.startsWith("/api/health") ||
    rawUrl.startsWith("/api/telegram")
  ) {
    return rawUrl.replace(/^\/api/, "");
  }

  return rawUrl;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    // Normalize target URL across all Vercel rewrite patterns
    req.url = resolveTargetUrl(req);

    const handled = await handleApiRequest(req, res);
    if (!handled) {
      sendJson(res, 404, { error: "Endpoint not found", path: req.url }, req);
    }
  } catch (error: any) {
    console.error("[Vercel API Gateway Error]:", error);
    if (!res.headersSent) {
      sendJson(
        res,
        500,
        {
          error: "Internal server error",
          message: error?.message || "Unknown error",
        },
        req
      );
    }
  }
}
