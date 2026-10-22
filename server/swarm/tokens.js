import crypto from "node:crypto";

const PREFIX = "sbat_";

/** An agent token is shown once; only its SHA-256 is stored. */
export function generateAgentToken() {
  return `${PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
}

export function hashAgentToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

export function looksLikeAgentToken(token) {
  return typeof token === "string" && token.startsWith(PREFIX) && token.length >= PREFIX.length + 40 && token.length <= 128;
}
