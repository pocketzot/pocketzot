// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeStorage } from '../test/fake-storage'
import { buildOfflineLobbyView } from './offline-lobby'
import { loadOfflineSlots, type OfflineChar } from '../offline/offline-state'
import { downloadOfflineData, probeReadiness, type Readiness } from '../offline/artifact-store'

// "New game"'s two homes, the name form, and the menu card — the view's
// state logic, driven through its three async seams. The sprite path is
// inert under happy-dom (no Cache API → resolveRuneSource answers null) and
// the records read fails safe at its call site.
vi.mock('../offline/offline-state', async (orig) => ({
  ...(await orig<typeof import('../offline/offline-state')>()),
  loadOfflineSlots: vi.fn(),
}))
vi.mock('../offline/artifact-store', async (orig) => ({
  ...(await orig<typeof import('../offline/artifact-store')>()),
  probeReadiness: vi.fn(),
  measureOfflineData: vi.fn(async () => ({ total: 0 })),
  downloadOfflineData: vi.fn(),
}))
vi.mock('../offline/save-transfer', async (orig) => ({
  ...(await orig<typeof import('../offline/save-transfer')>()),
  fetchEngineBuild: vi.fn(async () => null),
}))

const READY: Readiness = { state: 'ready', tiles: true, update: false, deploy: 'ok' }
const NOT_CACHED = { state: 'not-cached' } as Readiness
const char = (name: string): OfflineChar => ({ name, when: 1 })
const slots = (...names: string[]) => ({
  stems: names, chars: Object.fromEntries(names.map((n) => [n, char(n)])),
})
const settle = () => new Promise((r) => setTimeout(r, 0))

let view: HTMLElement
const $ = <T extends HTMLElement = HTMLElement>(q: string): T => view.querySelector<T>(q)!
const shown = (q: string): boolean => {
  for (let e: HTMLElement | null = $(q); e && e !== view; e = e.parentElement) if (e.hidden) return false
  return true
}

async function mount(opts: { saves?: string[]; seeded?: string[]; readiness?: Readiness } = {}): Promise<void> {
  if (opts.seeded) {
    localStorage.setItem('pocketzot:offline-chars', JSON.stringify(slots(...opts.seeded).chars))
  }
  vi.mocked(loadOfflineSlots).mockResolvedValue(slots(...(opts.saves ?? [])))
  vi.mocked(probeReadiness).mockResolvedValue(opts.readiness ?? READY)
  view = buildOfflineLobbyView(vi.fn(), vi.fn())
  document.body.append(view)
  await settle()
}

beforeEach(() => { vi.stubGlobal('localStorage', fakeStorage()) })
afterEach(() => { view?.remove(); vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('offline lobby: New game', () => {
  it('is the primary bar while there are no saved games', async () => {
    await mount()
    expect(shown('#offline-new')).toBe(true)
    expect(shown('#offline-new-row')).toBe(false)
    expect($('#offline-menu-card').hidden).toBe(true)
    expect($('#offline-name-form').parentElement).toBe($('#offline-actions'))
    expect($('#offline-gate-note').previousElementSibling).toBe($('#offline-actions'))
  })

  it('is the quiet menu-card row once there are', async () => {
    await mount({ saves: ['Mog'] })
    expect(shown('#offline-new')).toBe(false)
    expect(shown('#offline-new-row')).toBe(true)
    expect($('#offline-name-form').parentElement).toBe($('#offline-menu-card'))
    expect($('#offline-gate-note').previousElementSibling).toBe($('#offline-saves-title'))
  })

  it('is reachable even if the slot probe never settles', async () => {
    vi.mocked(loadOfflineSlots).mockReturnValue(new Promise(() => {}))
    vi.mocked(probeReadiness).mockResolvedValue(READY)
    view = buildOfflineLobbyView(vi.fn(), vi.fn())
    document.body.append(view)
    await settle()
    expect(shown('#offline-new')).toBe(true)
  })

  it('seeds its home from the slot records before the probe lands', () => {
    localStorage.setItem('pocketzot:offline-chars', JSON.stringify(slots('Mog').chars))
    vi.mocked(loadOfflineSlots).mockReturnValue(new Promise(() => {}))
    vi.mocked(probeReadiness).mockResolvedValue(READY)
    view = buildOfflineLobbyView(vi.fn(), vi.fn())
    document.body.append(view)
    expect(shown('#offline-new-row')).toBe(true)
    expect(shown('#offline-new')).toBe(false)
  })
})

describe('offline lobby: name form', () => {
  it('opens in place of the tapped control; Cancel and Escape restore it', async () => {
    await mount()
    $('#offline-new').click()
    expect(shown('#offline-name-form')).toBe(true)
    expect(shown('#offline-new')).toBe(false)
    $<HTMLInputElement>('#offline-name').value = 'Zed'
    $('#offline-name-cancel').click()
    expect(shown('#offline-name-form')).toBe(false)
    expect(shown('#offline-new')).toBe(true)
    expect($<HTMLInputElement>('#offline-name').value).toBe('')
    expect(document.activeElement).toBe($('#offline-new'))

    $('#offline-new').click()
    $('#offline-name-form').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(shown('#offline-name-form')).toBe(false)
  })

  it('restores the row, inside a still-visible card, when cancelled from the card', async () => {
    await mount({ saves: ['Mog'] })
    $('#offline-new-row').click()
    expect(shown('#offline-name-form')).toBe(true)
    expect(shown('#offline-new-row')).toBe(false)
    expect($('#offline-menu-card').hidden).toBe(false) // the open form keeps the card up
    $('#offline-name-cancel').click()
    expect(shown('#offline-new-row')).toBe(true)
    expect(document.activeElement).toBe($('#offline-new-row'))
  })

  it('follows a home change while open, keeping focus and the typed name', async () => {
    // The seed says "no saves" (bar); the form opens from the bar; then a
    // slot read lands saves — the same placeNewGame(true)-under-an-open-form
    // a backup import onto an empty device produces.
    let land!: (v: ReturnType<typeof slots>) => void
    vi.mocked(loadOfflineSlots).mockReturnValue(new Promise((r) => { land = r }))
    vi.mocked(probeReadiness).mockResolvedValue(READY)
    view = buildOfflineLobbyView(vi.fn(), vi.fn())
    document.body.append(view)
    await settle()
    $('#offline-new').click()
    const input = $<HTMLInputElement>('#offline-name')
    input.value = 'Zed'
    expect(document.activeElement).toBe(input)

    land(slots('Mog'))
    await settle()
    expect($('#offline-name-form').parentElement).toBe($('#offline-menu-card'))
    expect(shown('#offline-name-form')).toBe(true)
    expect(shown('#offline-new')).toBe(false)
    expect(shown('#offline-new-row')).toBe(false)
    expect(input.value).toBe('Zed')
    expect(document.activeElement).toBe(input)
  })

  it('drops a submit that was cancelled before the slot read landed — no launch, no stale error', async () => {
    let land!: (v: ReturnType<typeof slots>) => void
    vi.mocked(loadOfflineSlots).mockReturnValue(new Promise((r) => { land = r }))
    vi.mocked(probeReadiness).mockResolvedValue(READY)
    const onPlay = vi.fn()
    view = buildOfflineLobbyView(onPlay, vi.fn())
    document.body.append(view)
    await settle()
    $('#offline-new').click()
    $<HTMLInputElement>('#offline-name').value = 'Zed'
    $('#offline-name-form').dispatchEvent(new Event('submit', { cancelable: true }))
    $('#offline-name-cancel').click()
    land(slots())
    await settle()
    expect(onPlay).not.toHaveBeenCalled()
    // The reset input would fail validation; that must not be painted into
    // the closed form for the next open to find.
    expect($('#offline-name-error').style.display).toBe('none')
  })

  it('launches a submit that was not cancelled', async () => {
    const onPlay = vi.fn()
    vi.mocked(loadOfflineSlots).mockResolvedValue(slots())
    vi.mocked(probeReadiness).mockResolvedValue(READY)
    view = buildOfflineLobbyView(onPlay, vi.fn())
    document.body.append(view)
    await settle()
    $('#offline-new').click()
    $<HTMLInputElement>('#offline-name').value = 'Zed'
    $('#offline-name-form').dispatchEvent(new Event('submit', { cancelable: true }))
    await settle()
    expect(onPlay).toHaveBeenCalledWith('Zed')
  })
})

describe('offline lobby: download lifecycle', () => {
  it('disables every New-game control while downloading, and releases them on failure', async () => {
    let fail!: (e: Error) => void
    vi.mocked(downloadOfflineData).mockReturnValue(new Promise((_, rej) => { fail = rej }))
    await mount({ saves: ['Mog'], readiness: NOT_CACHED })
    $('#offline-download').click()
    await settle()
    expect($('#offline-new-row').classList.contains('is-disabled')).toBe(true)
    expect($('#offline-new-row').getAttribute('aria-disabled')).toBe('true')
    expect($<HTMLButtonElement>('#offline-name-cancel').disabled).toBe(true)
    $('#offline-new-row').click()
    expect(shown('#offline-name-form')).toBe(false) // inert

    fail(new Error('offline'))
    await settle()
    expect($('#offline-new-row').classList.contains('is-disabled')).toBe(false)
    expect($<HTMLButtonElement>('#offline-name-cancel').disabled).toBe(false)
    expect($('#lobby-notice').textContent).toContain('Download failed')
  })
})
