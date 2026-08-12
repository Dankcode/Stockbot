export const SESSION_API_TOKEN_STORAGE_KEY: string;

export type SessionStorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type SessionTokenStore = {
  get(): string;
  isConfigured(): boolean;
  set(value: string): void;
  clear(): void;
  subscribe(listener: () => void): () => void;
};

export function createSessionTokenStore(storage?: SessionStorageLike | null): SessionTokenStore;
export function getSessionApiToken(): string;
export function isSessionApiTokenConfigured(): boolean;
export function setSessionApiToken(value: string): void;
export function clearSessionApiToken(): void;
export function subscribeSessionApiToken(listener: () => void): () => void;
