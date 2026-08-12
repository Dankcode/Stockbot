import cors from "cors";
import express from "express";
import path from "node:path";
import { accountsRouter } from "./routes/accounts.js";
import { alertsRouter } from "./routes/alerts.js";
import { algorithmsRouter } from "./routes/algorithms.js";
import { marketRouter } from "./routes/market.js";
import { overviewRouter } from "./routes/overview.js";
import { riskRouter } from "./routes/risk.js";
import { sessionsRouter } from "./routes/sessions.js";
import { settingsRouter } from "./routes/settings.js";
import { systemRouter } from "./routes/system.js";
import { errorHandler, mutationAuth, notFound, requestContext } from "./middleware.js";

function localOrigin(origin) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  } catch { return false; }
}

export function mountProductionWeb(app, {
  workspaceRoot,
  nodeEnv = process.env.NODE_ENV
} = {}) {
  if (nodeEnv !== "production") return false;
  if (!workspaceRoot) throw new TypeError("workspaceRoot is required when serving the production web app.");

  const webRoot = path.join(workspaceRoot, "dist");
  app.use(express.static(webRoot, {
    index: false,
    maxAge: "1h",
    setHeaders(response, filename) {
      if (path.basename(filename) === "index.html") {
        response.setHeader("cache-control", "no-cache");
      }
    }
  }));
  app.get(/^(?!\/api(?:\/|$)).*/, (_request, response, next) => {
    response.setHeader("cache-control", "no-cache");
    response.sendFile("index.html", { root: webRoot }, (error) => {
      if (error) next(error);
    });
  });
  return true;
}

export function createHttpApp(context) {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors({ origin: (origin, callback) => callback(null, localOrigin(origin)), credentials: false }));
  app.use(express.json({ limit: "1mb", strict: true }));
  app.use(requestContext);
  app.use(mutationAuth(context.config));

  const api = express.Router();
  api.use(systemRouter(context));
  api.use("/market", marketRouter(context.market));
  api.use("/algorithms", algorithmsRouter(context.algorithms));
  api.use("/sessions", sessionsRouter(context.supervisor));
  api.use("/accounts", accountsRouter(context));
  api.use("/risk", riskRouter(context.repositories.risk, context.accountId));
  api.use("/alerts", alertsRouter(context.repositories.alerts, context.accountId));
  api.use("/settings", settingsRouter(context.settings, context.market));
  api.use("/overview", overviewRouter(context));
  api.get("/stream", (request, response) => context.eventHub.attach(response, request.get("last-event-id") || request.query.lastEventId));
  app.use("/api/v1", api);

  // A small compatibility probe for older local launch scripts.
  app.get("/api/health", (_request, response) => response.redirect(307, "/api/v1/health"));
  mountProductionWeb(app, { workspaceRoot: context.config.workspaceRoot });
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
