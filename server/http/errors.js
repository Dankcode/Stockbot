export class AppError extends Error {
  constructor(code, message, status = 400, detail) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export function asAppError(error) {
  if (error instanceof AppError) return error;
  const code = typeof error?.code === "string" ? error.code : "INTERNAL_ERROR";
  const knownStatus = {
    ALGORITHM_EXISTS: 409,
    ALGORITHM_FILENAME_INVALID: 400,
    ALGORITHM_SOURCE_INVALID: 422,
    ALGORITHM_VALIDATION_ERROR: 422,
    ALGORITHM_INVALID: 422,
    ALGORITHM_TOO_LARGE: 413,
    ALGORITHM_FORBIDDEN_CAPABILITY: 422,
    ALGORITHM_WORKER_REQUIRED: 503,
    ENGINE_TIMEOUT: 408,
    ENGINE_ABORTED: 409,
    ERR_DATABASE_URL: 500,
    ERR_MIGRATION_DRIFT: 500,
    SQLITE_CONSTRAINT_UNIQUE: 409
  }[code];
  if (knownStatus) return new AppError(code, error instanceof Error ? error.message : code, knownStatus, error?.detail);
  return new AppError("INTERNAL_ERROR", error instanceof Error ? error.message : "Unexpected error", 500);
}

export function unavailable(message, detail) {
  return new AppError("MARKET_DATA_UNAVAILABLE", message, 503, detail);
}
