// Teardown registry for top-level views. A view that installs listeners
// outside its own subtree (document/window handlers, a CloseWatcher,
// matchMedia subscriptions) registers how to undo them; the app shell runs
// that when it replaces the view (app.ts:setView), whatever route replaced
// it. The game view's deliberate exits already tore down through
// exitToLobby, but the auto-resume route rebuilds the view without one —
// every app-swap on a phone leaked a whole view graph through the touch
// panel's document-level capture listeners, and on Android left a spent
// CloseWatcher armed per resume.

const disposers = new WeakMap<Element, () => void>()

export function registerViewDispose(el: Element, dispose: () => void): void {
  disposers.set(el, dispose)
}

// Runs and forgets the element's disposer, if any. Safe to call on a view
// that already tore itself down (disposers must be idempotent).
export function disposeView(el: Element): void {
  const fn = disposers.get(el)
  if (!fn) return
  disposers.delete(el)
  fn()
}
