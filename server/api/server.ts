import { createServer } from "node:http";
import { handleApiRequest, sendJson } from "./routes.ts";
import { veraTelegramBot } from "../telegram/bot.ts";

try {
  process.loadEnvFile?.();
} catch {}

const PORT = parseInt(process.env.PORT || "3001", 10);

export function startServer(port = PORT) {
  const server = createServer(async (req, res) => {
    (res as any).__req = req;
    const handled = await handleApiRequest(req, res);
    if (!handled) {
      sendJson(res, 404, { error: "Endpoint not found" }, req);
    }
  });

  server.listen(port, () => {
    console.log(`[VeraOS API] Verification Engine Server active on http://localhost:${port}`);
  });

  const telegramMode = process.env.TELEGRAM_MODE?.toLowerCase();
  const shouldPoll =
    telegramMode === "embedded_polling" ||
    process.env.RUN_TELEGRAM_IN_SERVER === "true" ||
    (Boolean(process.env.TELEGRAM_BOT_TOKEN) && telegramMode !== "disabled" && process.env.NODE_ENV !== "test");

  if (shouldPoll && process.env.TELEGRAM_BOT_TOKEN && !veraTelegramBot.isPollingActive()) {
    veraTelegramBot.setApiBaseUrl(`http://localhost:${port}`);
    veraTelegramBot.startPolling();
  }

  return server;
}

// Start immediately if executed directly
if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  startServer();
}
