import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import router from "./routes";
import { botRequestHandler } from "./bullet-bot/bot-runtime.mjs";
import { executorEnabled, executorRequestHandler } from "./executor";
import { INTAKE_PATHS } from "./executor/intake";
import { logger } from "./lib/logger";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
app.use(cors({ credentials: true, origin: true }));
// Bullet already sends to the original ingress URL. Route its POST to the new
// PAPER bot before the JSON parser consumes the raw body. Historical GET routes
// remain on the legacy receiver, but it no longer accepts new signals.
app.use((req, res, next) => {
  // New executor (owner 2026-11-02): signals and commands go straight to it.
  if (executorEnabled() && req.method === "POST" && INTAKE_PATHS.has(req.path)) {
    executorRequestHandler(req, res);
    return;
  }
  if (req.path.startsWith("/api/bot/") ||
      (req.path === "/api/trading/signals" && req.method === "POST") ||
      req.path === "/api/trading/commands" ||
      req.path === "/api/trading/reset") {
    botRequestHandler(req, res);
    return;
  }
  next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

app.use("/api", router);

app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
  if (req.path === "/api/trading/signals" && error && typeof error === "object" &&
      "type" in error && error.type === "entity.parse.failed") {
    req.log.warn({ rejectCode: "MALFORMED_JSON" }, "Trading signal rejected at intake");
    res.status(400).json({ error: "MALFORMED_JSON" });
    return;
  }
  next(error);
});

export default app;
