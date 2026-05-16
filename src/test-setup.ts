// Vitest setup — runs once before all unit tests

// Robust localStorage shim for jsdom (its built-in stub is incomplete in some envs)
if (typeof window !== "undefined") {
  const store = new Map<string, string>();
  const ls: Storage = {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    removeItem: (k: string) => { store.delete(k); },
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
  };
  Object.defineProperty(window, "localStorage", { value: ls, configurable: true, writable: true });
  Object.defineProperty(globalThis, "localStorage", { value: ls, configurable: true, writable: true });
}
