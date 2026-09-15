// Installed iOS: drop viewport-fit=cover at boot so WebKit paints the status
// bar itself — the only page-side way past iOS 27's top-edge blur.
//
// The blur is the web view's soft top scroll-edge effect ("scroll pocket").
// WebKit hides it whenever it extends a fixed top element's colour over the
// top OBSCURED inset (_shouldHideTopScrollPocket, WKWebViewIOS.mm), and it
// samples the top edge only when that inset is > 0
// (WebPage::sidesRequiringFixedContainerEdges, WebPageCocoa.mm). Under cover
// the Home Screen host leaves it at 0 (avoidsUnsafeArea = fit != Cover,
// ViewportConfiguration.cpp), so no meta, colour or element reaches the blur
// there. On-device 2026-09-14: an env-tall strip under cover stayed blurred;
// without cover a 12px strip (#status-strip, style.css) turned the whole bar
// solid in its colour. The chain is identical on the Safari 27 release
// branch (safari-7625); Apple documents none of it. Full log:
// dev-material/ios-safe-area-viewport.md, "iOS 27".
//
// The gate is Apple's documented detector for exactly this condition:
// navigator.standalone, which tells "whether a webpage is displaying in
// standalone mode" (Safari Web Content Guide, "Configuring Web
// Applications"). Apple's rule is feature detection first and the user agent
// "only as a last resort" (same guide, "Follow Good Web Design Practices"),
// and the flag is set by the Home Screen web-app host itself — where the blur
// lives. Safari tabs read false; Android and desktop leave it undefined, so
// they keep cover. Read the VALUE, never the property's presence: WebKit
// exposes it on every Cocoa platform, macOS included
// (ENABLE_NAVIGATOR_STANDALONE, PlatformEnableCocoa.h). Never gate on the
// UA's "CPU iPhone OS N_N" token either — it is frozen at 18_7
// (whatwg/compat#283).
//
// Every iOS version gets the swap, not just 27: one look everywhere, and a
// version gate is the part that would go stale when Apple changes the blur.
//
// Cost: the map no longer runs under the Dynamic Island, and env() insets
// read 0 after the swap — the --safe-* tokens come from the classes set here
// instead (style.css, the html.pz-status-blur block).

import { hiddenProbe } from './safe-area-probe'

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
// cost that one launch its bottom pin.
function hasHomeIndicator(): boolean {
  const probe = hiddenProbe('padding-bottom:env(safe-area-inset-bottom,0px);')
  document.body.append(probe)
  const px = parseFloat(getComputedStyle(probe).paddingBottom)
  probe.remove()
  return px > 0
}

export function applyStatusBlur(doc: Document, homeIndicator: boolean): void {
  const root = doc.documentElement
  root.classList.add(STATUS_BLUR_CLASS)
  root.classList.toggle(HOME_INDICATOR_CLASS, homeIndicator)
  // WebKit reprocesses a viewport meta whose content changes
  // (HTMLMetaElement::attributeChanged → Document::processViewport).
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]')
  if (meta) meta.content = withoutViewportFit(meta.content)
}

// Boot (main.ts), before the first view mounts: #app is still empty, so the
// relayout the meta change triggers has nothing to move.
export function initStatusBlur(): void {
  if ((navigator as { standalone?: boolean }).standalone !== true) return
  applyStatusBlur(document, hasHomeIndicator())
}
