export class TtlCache {
  #items = new Map();

  get(key) {
    const item = this.#items.get(key);
    if (!item || item.expiresAt <= Date.now()) {
      this.#items.delete(key);
      return undefined;
    }
    return item.value;
  }

  set(key, value, ttlMs) {
    this.#items.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  }

  delete(key) { this.#items.delete(key); }
  clear() { this.#items.clear(); }
}
