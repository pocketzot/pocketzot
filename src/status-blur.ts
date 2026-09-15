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

// env(safe-area-inset-bottom) only reports under cover, so this must run
// before the meta rewrite — the last moment the inset is honest. A cold-start
// all-zero read (the unconfirmed flakiness, dev-material "sticky shim") would
// cost that one launch its bottom pin. env() isn't readable from JS
// directly — resolved via computed style on a hidden fixed element.
function hasHomeIndicator(): boolean {
  const probe = document.createElement('div')
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;padding-bottom:env(safe-area-inset-bottom,0px);'
  document.body.append(probe)
  const px = parseFloat(getComputedStyle(probe).paddingBottom)
  probe.remove()
  return px > 0
}

// Boot (main.ts), before the first view mounts: #app is still empty, so the
// relayout the meta change triggers has nothing to move.
export function initStatusBlur(): void {
  if ((navigator as { standalone?: boolean }).standalone !== true) return
  const root = document.documentElement
  root.classList.add(STATUS_BLUR_CLASS)
  root.classList.toggle(HOME_INDICATOR_CLASS, hasHomeIndicator())
  // WebKit reprocesses a viewport meta whose content changes
  // (HTMLMetaElement::attributeChanged → Document::processViewport).
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
  if (meta) meta.content = withoutViewportFit(meta.content)
}
