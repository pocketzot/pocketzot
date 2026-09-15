// Installed iOS: drop viewport-fit=cover at boot so WebKit paints the status
// bar itself — the only page-side way past iOS 27's top-edge blur.
//
// WebKit hides the blur (the top "scroll pocket") only when a fixed top
// element's colour extends over a top obscured inset > 0
// (_shouldHideTopScrollPocket, WKWebViewIOS.mm;
// WebPage::sidesRequiringFixedContainerEdges, WebPageCocoa.mm), and under
// cover the Home Screen host leaves that inset at 0 (avoidsUnsafeArea =
// fit != Cover, ViewportConfiguration.cpp) — so no meta, colour or element
// reaches the blur while cover is on. On-device 2026-09-14: a strip under
// cover stayed blurred; without cover it turned the whole bar solid. The
// tokens the swap feeds (#status-strip, --safe-*) live in style.css, the
// html.pz-status-blur block. Full trace: dev-material/ios-safe-area-viewport.md,
// "iOS 27".
//
// Gate: navigator.standalone === true — Apple's documented detector for
// exactly this condition ("whether a webpage is displaying in standalone
// mode", Safari Web Content Guide, "Configuring Web Applications"), set by
// the Home Screen web-app host itself. Safari tabs read false; Android and
// desktop leave it undefined and keep cover. Read the VALUE, never the
// property's presence: WebKit exposes it on every Cocoa platform, macOS
// included (ENABLE_NAVIGATOR_STANDALONE, PlatformEnableCocoa.h). Never gate
// on the user agent: Apple's own guidance is feature detection first, UA
// "only as a last resort" (same guide, "Follow Good Web Design Practices"),
// and the "CPU iPhone OS N_N" token is frozen at 18_7 anyway
// (whatwg/compat#283). Never gate on an iOS version either: every version
// gets the swap, so nothing here goes stale when Apple moves the blur.

export const STATUS_BLUR_CLASS = 'pz-status-blur'
export const HOME_INDICATOR_CLASS = 'pz-home-indicator'

export function withoutViewportFit(content: string): string {
  return content
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '' && !/^viewport-fit\s*=/i.test(s))
    .join(', ')
}

// The home-indicator read. env(safe-area-inset-bottom) only reports under
// cover, so it must happen before the meta rewrite — and not before the
// insets have reached the page at all. iOS delivers them with the UI
// process's visible-content-rect updates (WebPage::updateVisibleContentRects,
// WebPageIOS.mm → Page::setUnobscuredSafeAreaInsets), an IPC the main thread
// handles between tasks, so a read inside the boot script can predate them
// and see 0. On-device 2026-09-15: a service-worker-cached boot read 0 and
// lost the pin on every launch; network-loaded boots (the first launch after
// a deploy, the LAN dev server) ran late enough to read 34. Never go back to
// one synchronous read.
//
// Arrival signal: any inset > 0. The four sides land together (one
// FloatBoxExtent), and under cover every portrait iPhone and every iPad has
// a status-bar top, so a zero bottom beside a real top is a genuine
// home-button device, not an early read. env() isn't readable from JS
// directly — resolved via computed style on a hidden fixed element.
const INSET_PROBE =
  'position:fixed;visibility:hidden;pointer-events:none;' +
  'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) ' +
  'env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);'

// Upper bound on the wait, not a measured arrival time: only a launch with no
// inset on any side (a home-button iPhone in landscape) runs it out, and this
// is the launch delay that case pays.
const INSET_WAIT_MS = 500

// Boot (main.ts): `then` mounts the first view. Off installed iOS it runs
// synchronously. On installed iOS it runs after the swap, polled per frame
// until the insets arrive, so #app is still empty when the meta change
// relayouts and nothing lays out twice.
export function initStatusBlur(then: () => void): void {
  if ((navigator as { standalone?: boolean }).standalone !== true) {
    then()
    return
  }
  const probe = document.createElement('div')
  probe.style.cssText = INSET_PROBE
  document.body.append(probe)
  const deadline = performance.now() + INSET_WAIT_MS
  const poll = (): void => {
    const s = getComputedStyle(probe)
    const sides = [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].map(v => parseFloat(v) || 0)
    if (sides.every(px => px === 0) && performance.now() < deadline) {
      requestAnimationFrame(poll)
      return
    }
    probe.remove()
    const root = document.documentElement
    root.classList.add(STATUS_BLUR_CLASS)
    root.classList.toggle(HOME_INDICATOR_CLASS, sides[2] > 0)
    // WebKit reprocesses a viewport meta whose content changes
    // (HTMLMetaElement::attributeChanged → Document::processViewport).
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    if (meta) meta.content = withoutViewportFit(meta.content)
    then()
  }
  poll()
}
