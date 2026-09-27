/**
 * vitest 全局 setup：node 环境下补 localStorage 替身（Map 语义）。
 * 与主工程规矩 11 同源——布局持久化（mirach.harness.layout.v6 等）的
 * 读写都走 localStorage，store/模块级单测需要它存在。
 */

if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>()
  const stub: Storage = {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    key: (i) => [...store.keys()][i] ?? null,
    removeItem: (k) => void store.delete(k),
    setItem: (k, v) => void store.set(k, String(v)),
  }
  Object.defineProperty(globalThis, 'localStorage', { value: stub, configurable: true })
}
