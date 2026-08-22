// Node 22+ defines its own `localStorage` / `sessionStorage` globals which resolve to
// `undefined` unless the process was started with `--localstorage-file`. Vitest's jsdom
// environment only installs a global when the key is not already present on globalThis,
// so Node's own (empty) globals win — and because vitest makes `window` an alias of
// globalThis, `window.localStorage` is undefined too. Every `localStorage.*` call in the
// web suite then throws "Cannot read properties of undefined".
//
// Install a minimal in-memory Storage in that case. The web code only uses
// getItem/setItem/removeItem/clear, and per-test isolation comes from the suites'
// own `localStorage.clear()` in beforeEach.
class MemoryStorage implements Storage {
  #map = new Map<string, string>()

  get length(): number {
    return this.#map.size
  }

  key(index: number): string | null {
    return [...this.#map.keys()][index] ?? null
  }

  getItem(key: string): string | null {
    return this.#map.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.#map.set(key, String(value))
  }

  removeItem(key: string): void {
    this.#map.delete(key)
  }

  clear(): void {
    this.#map.clear()
  }

  [name: string]: unknown
}

for (const key of ['localStorage', 'sessionStorage'] as const) {
  if ((globalThis as Record<string, unknown>)[key] == null) {
    Object.defineProperty(globalThis, key, {
      value: new MemoryStorage(),
      configurable: true,
      writable: true,
    })
  }
}
