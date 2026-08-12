import { z } from "zod";
import {
  ApiEnvelopeSchema,
  type ApiMeta
} from "../../packages/shared/schemas.js";
import { getSessionApiToken } from "./sessionAuth.js";

const API_ROOT = "/api/v1";

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: unknown;

  constructor(message: string, options: { code?: string; status?: number; detail?: unknown } = {}) {
    super(message);
    this.name = "ApiRequestError";
    this.code = options.code ?? "REQUEST_FAILED";
    this.status = options.status ?? 0;
    this.detail = options.detail;
  }
}

export function getAccountId() {
  return import.meta.env.VITE_STOCKBOT_ACCOUNT_ID?.trim() || "default-paper";
}

export function apiUrl(path: string) {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${API_ROOT}${normalized}`;
}

export type ApiResponse<T> = {
  data: T;
  meta: ApiMeta;
};

async function parseResponse<T>(response: Response, schema?: z.ZodType<T>): Promise<ApiResponse<T>> {
  if (response.status === 401) {
    throw new ApiRequestError(
      "API authorization is required. Enter or update the server API token in Settings for this browser session, then retry.",
      { code: "AUTH_REQUIRED", status: response.status }
    );
  }
  if (response.status === 403) {
    throw new ApiRequestError(
      "The server rejected this browser session's API token. Update or clear it in Settings, then retry.",
      { code: "AUTH_FORBIDDEN", status: response.status }
    );
  }
  const text = await response.text();
  if (!text) {
    if (!response.ok) {
      throw new ApiRequestError(`API route unavailable (${response.status}).`, {
        code: "HTTP_ERROR",
        status: response.status
      });
    }
    throw new ApiRequestError("The server returned an empty response.", {
      code: "EMPTY_RESPONSE",
      status: response.status
    });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    if (!response.ok) {
      throw new ApiRequestError(`API route unavailable (${response.status}).`, {
        code: "HTTP_ERROR",
        status: response.status
      });
    }
    throw new ApiRequestError("The server returned invalid JSON.", {
      code: "INVALID_JSON",
      status: response.status
    });
  }
  const envelope = ApiEnvelopeSchema.safeParse(payload);
  if (!envelope.success) {
    throw new ApiRequestError("The server response did not match the API contract.", {
      code: "INVALID_ENVELOPE",
      status: response.status,
      detail: envelope.error.flatten()
    });
  }
  if ("error" in envelope.data) {
    throw new ApiRequestError(envelope.data.error.message, {
      code: envelope.data.error.code,
      status: response.status,
      detail: envelope.data.error.detail
    });
  }
  if (!response.ok) {
    throw new ApiRequestError(`Request failed with status ${response.status}.`, { status: response.status });
  }
  if (!schema) {
    return { data: envelope.data.data as T, meta: envelope.data.meta };
  }
  const resource = schema.safeParse(envelope.data.data);
  if (!resource.success) {
    throw new ApiRequestError("The server response data did not match the API contract.", {
      code: "INVALID_RESOURCE",
      status: response.status,
      detail: resource.error.flatten()
    });
  }
  return { data: resource.data, meta: envelope.data.meta };
}

export async function apiRequestWithMeta<T>(
  path: string,
  init: RequestInit = {},
  schema?: z.ZodType<T>
): Promise<ApiResponse<T>> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const method = (init.method ?? "GET").toUpperCase();
  const isMutation = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
  const token = isMutation ? getSessionApiToken() : "";
  if (isMutation && token) {
    headers.set("X-Stockbot-Token", token);
  }
  let response: Response;
  try {
    response = await fetch(apiUrl(path), { ...init, headers });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new ApiRequestError("Stockbot could not reach the API.", {
      code: "NETWORK_ERROR",
      detail: error
    });
  }
  return parseResponse(response, schema);
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
  schema?: z.ZodType<T>
): Promise<T> {
  return (await apiRequestWithMeta(path, init, schema)).data;
}

export const api = {
  get<T>(path: string, signal?: AbortSignal) {
    return apiRequest<T>(path, { method: "GET", signal });
  },
  getValidated<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal) {
    return apiRequest(path, { method: "GET", signal }, schema);
  },
  getWithMeta<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal) {
    return apiRequestWithMeta(path, { method: "GET", signal }, schema);
  },
  post<T>(path: string, body?: unknown, signal?: AbortSignal) {
    return apiRequest<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body), signal });
  },
  postValidated<T>(path: string, body: unknown, schema: z.ZodType<T>, signal?: AbortSignal) {
    return apiRequest(path, { method: "POST", body: JSON.stringify(body), signal }, schema);
  },
  patch<T>(path: string, body: unknown, signal?: AbortSignal) {
    return apiRequest<T>(path, { method: "PATCH", body: JSON.stringify(body), signal });
  },
  patchValidated<T>(path: string, body: unknown, schema: z.ZodType<T>, signal?: AbortSignal) {
    return apiRequest(path, { method: "PATCH", body: JSON.stringify(body), signal }, schema);
  },
  put<T>(path: string, body: unknown, signal?: AbortSignal) {
    return apiRequest<T>(path, { method: "PUT", body: JSON.stringify(body), signal });
  },
  putValidated<T>(path: string, body: unknown, schema: z.ZodType<T>, signal?: AbortSignal) {
    return apiRequest(path, { method: "PUT", body: JSON.stringify(body), signal }, schema);
  },
  delete<T>(path: string, body?: unknown, signal?: AbortSignal) {
    return apiRequest<T>(path, { method: "DELETE", body: body === undefined ? undefined : JSON.stringify(body), signal });
  }
};

export function listFrom<T>(payload: unknown, keys: string[]): T[] {
  if (Array.isArray(payload)) {
    return payload as T[];
  }
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const record = payload as Record<string, unknown>;
  for (const key of keys) {
    if (Array.isArray(record[key])) {
      return record[key] as T[];
    }
  }
  return [];
}
