import crypto from "node:crypto";
import { AppError, asAppError } from "./errors.js";

export function requestContext(request, response, next) {
  const requestId = request.get("x-request-id") || crypto.randomUUID();
  request.requestId = requestId;
  response.locals.requestId = requestId;
  response.setHeader("x-request-id", requestId);
  next();
}

export function mutationAuth(config) {
  return (request, _response, next) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return next();
    if (!config.apiToken) return next();
    if (!validToken(config.apiToken, request.get("x-stockbot-token") || "")) {
      return next(new AppError("AUTH_REQUIRED", "A valid Stockbot API token is required.", 401));
    }
    next();
  };
}

function validToken(expected, supplied) {
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

/** Always protects sensitive routes, including GET, unlike mutationAuth. */
export function operatorAuth(config) {
  return (request, _response, next) => {
    if (!config.apiToken) {
      return next(new AppError(
        "AUTH_NOT_CONFIGURED",
        "Configure STOCKBOT_API_TOKEN before using the research API.",
        503
      ));
    }
    if (!validToken(config.apiToken, request.get("x-stockbot-token") || "")) {
      return next(new AppError("AUTH_REQUIRED", "A valid Stockbot API token is required.", 401));
    }
    next();
  };
}

export function validate(schema, target = "body") {
  return (request, _response, next) => {
    const result = schema.safeParse(request[target]);
    if (!result.success) {
      next(new AppError("VALIDATION_ERROR", "Request validation failed.", 400, result.error.flatten()));
      return;
    }
    request[target] = result.data;
    next();
  };
}

export function asyncHandler(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

export function sendData(response, data, meta = {}) {
  response.json({ data, meta: { requestId: response.locals.requestId, ...meta } });
}

export function notFound(request, _response, next) {
  next(new AppError("NOT_FOUND", `No route for ${request.method} ${request.path}`, 404));
}

export function errorHandler(error, request, response, _next) {
  const appError = asAppError(error);
  if (appError.status >= 500) console.error(`[${request.requestId || "unknown"}]`, error);
  response.status(appError.status).json({
    error: {
      code: appError.code,
      message: appError.status >= 500 && process.env.NODE_ENV === "production" ? "Internal server error" : appError.message,
      ...(appError.detail === undefined ? {} : { detail: appError.detail })
    }
  });
}
