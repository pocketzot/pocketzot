/* Safe-area / viewport diagnostic chip (permanent, query-gated).
 *
 * Born as the measurement rig for the viewport-fit=cover migration
 * (dev-material/ios-safe-area-viewport.md), kept as a standing diagnostic:
 * after a major iOS update, one look at this chip tells you whether the
 * env()/viewport behavior moved. It shows the four raw insets, the resolved
 * --safe-bottom/--safe-top (the values the layout actually consumes), the
 * display mode, and viewport geometry (innerHeight vs screen etc. — to catch
 * the mixed state where the content origin moves to the physical top but the
 * layout viewport keeps its old pre-cover height, leaving a dead band at
 * the bottom).
 *
 * Mounting: `?safearea=1` shows it (and persists the flag for later loads);
 * `?safearea=0` clears the flag. Installed PWAs launch at the manifest's
 * start_url so a query can't reach them — DEV builds therefore auto-show
 * the chip whenever running standalone. Tap the chip to dismiss it (also
 * clears the persisted flag).
 */
const FLAG_KEY = 'pocketzot:safearea'

/* "Running as an installed app"; must stay in sync with the `@media
 * (display-mode: standalone), (display-mode: fullscreen)` block in style.css.
 * `navigator.standalone` is the legacy iOS fallback. */
function isInstalledDisplayMode(): boolean {
  return (
    window.matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches ||
    ('standalone' in navigator && (navigator as { standalone?: boolean }).standalone === true)
  )
}

/* env()/viewport units aren't readable from JS directly — resolve them via
 * computed style on a hidden fixed-position element. */
export function hiddenProbe(style: string): HTMLDivElement {
  const el = document.createElement('div')
  el.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;' + style
  return el
}

export function maybeMountSafeAreaProbe(): void {
  const q = new URLSearchParams(location.search).get('safearea')
  if (q === '0') {
    localStorage.removeItem(FLAG_KEY)
    return
  }
  if (q !== null) localStorage.setItem(FLAG_KEY, '1')

  const standalone = isInstalledDisplayMode()
  const flagged = localStorage.getItem(FLAG_KEY) === '1'
  if (!flagged && !(import.meta.env.DEV && standalone)) return

  const probe = hiddenProbe(
    'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) ' +
      'env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);',
  )
  const resolved = hiddenProbe('padding-bottom:var(--safe-bottom,0px);padding-top:var(--safe-top,0px);')
  // Viewport-unit rulers: on iOS standalone cold start the dynamic viewport
  // (dvh) sticks at the pre-cover size while vh resolves the real screen —
  // these two lines are the direct proof/refutation on-device.
  const vhRuler = hiddenProbe('height:100vh;')
  const dvhRuler = hiddenProbe('height:100dvh;')

  const chip = document.createElement('div')
  chip.style.cssText =
    'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9999;' +
    'background:rgba(0,0,0,0.85);color:#fce94f;border:1px solid #8f5902;border-radius:6px;' +
    'padding:0.5rem 0.7rem;font:12px/1.5 monospace;cursor:pointer;white-space:pre;'

  const els = [probe, resolved, vhRuler, dvhRuler, chip]
  const listeners = new AbortController()
  chip.addEventListener('click', () => {
    localStorage.removeItem(FLAG_KEY)
    listeners.abort()
    for (const el of els) el.remove()
  })

  document.body.append(...els)

  // Which display-mode the OS actually granted (the manifest may ask for
  // fullscreen and be silently downgraded to standalone). MQLs update live.
  const displayModes = ['fullscreen', 'standalone', 'minimal-ui', 'browser'].map(
    m => [m, window.matchMedia(`(display-mode: ${m})`)] as const,
  )

  const update = (): void => {
    const p = getComputedStyle(probe)
    const r = getComputedStyle(resolved)
    const appH = document.getElementById('app')?.getBoundingClientRect().height ?? 0
    const dm = displayModes.find(([, mq]) => mq.matches)?.[0]
    // Which physical side the notch/island is on can't be read from env() —
    // iOS reports landscape left/right insets symmetrically. These two values
    // are the raw material for inferring it; reading them side by side in
    // both landscape rotations pins the type↔side mapping empirically.
    const so = screen.orientation as ScreenOrientation | undefined
    const legacy = (window as { orientation?: number }).orientation
    chip.textContent =
      `mode: ${standalone ? 'installed' : 'tab'} (display-mode: ${dm ?? '?'})\n` +
      // The installed-iOS swap (status-blur.ts): while it's on, env reads 0
      // and the --safe-* lines below come from these classes instead.
      `status-blur: ${document.documentElement.classList.contains('pz-status-blur') ? 'on' : 'off'}` +
      `  home-indicator: ${document.documentElement.classList.contains('pz-home-indicator') ? 'yes' : 'no'}\n` +
      `orient: ${so?.type ?? 'n/a'} (angle ${so?.angle ?? '?'}` +
      `, window.orientation ${legacy ?? 'n/a'})\n` +
      `env top:    ${p.paddingTop}\n` +
      `env right:  ${p.paddingRight}\n` +
      `env bottom: ${p.paddingBottom}\n` +
      `env left:   ${p.paddingLeft}\n` +
      `--safe-bottom: ${r.paddingBottom}` +
      `  --safe-top: ${r.paddingTop}\n` +
      `innerH: ${window.innerHeight}  clientH: ${document.documentElement.clientHeight}\n` +
      `visualVp: ${window.visualViewport ? Math.round(window.visualViewport.height) : 'n/a'}` +
      `  screen: ${screen.height}\n` +
      `100vh: ${Math.round(vhRuler.getBoundingClientRect().height)}` +
      `  100dvh: ${Math.round(dvhRuler.getBoundingClientRect().height)}\n` +
      `#app: ${Math.round(appH)}\n` +
      `(tap to dismiss)`
  }
  update()
  const { signal } = listeners
  window.addEventListener('resize', update, { signal })
  window.addEventListener('orientationchange', update, { signal })
  // A 180° flip (landscape-primary ↔ -secondary) keeps the viewport size, so
  // resize never fires for it; this is the event that does.
  screen.orientation?.addEventListener('change', update, { signal })
  window.visualViewport?.addEventListener('resize', update, { signal })
}
