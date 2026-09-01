import aboutMd from '../../ABOUT.md?raw'
import changelogMd from '../../CHANGELOG.md?raw'
import { openDocView } from './doc-view'
import { getPref, setPref } from '../prefs'

// The committed ABOUT.md / CHANGELOG.md are the canonical project surfaces: they
// ship inside the JS bundle, so every build — including forks — carries the
// source/license/attribution links and version history, with no gitignored HTML
// files or env flags required. The static public/*.html pages are just the
// operator's SEO/marketing mirrors.

const REPO = 'https://github.com/pocketzot/pocketzot'

// ABOUT.md uses repo-relative links (LICENSE, ATTRIBUTION.md) that only resolve
// on GitHub. Rewrite them for web display; leave absolute http/mailto and
// root-absolute paths untouched.
function resolveAboutLink(href: string): string {
  if (/^(https?:|mailto:)/i.test(href)) return href
  if (href.startsWith('/') || href.startsWith('#')) return href
  return `${REPO}/blob/main/${href}`
}

// Strip any leading HTML comment (maintainer note) and the leading H1, which is
// shown as the dialog title instead.
function prep(md: string): string {
  return md.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*#\s+.*(?:\r?\n)?/, '')
}

export function openAboutDoc(): void {
  openDocView('About', prep(aboutMd), { resolveLink: resolveAboutLink })
}

// Unread "What's new" state: each changelog entry is a dated `## YYYY-MM-DD`
// heading (newest first), and the bundle a user is running always carries the
// changelog it shipped with — so "unread" is just "the newest entry's date
// isn't the one they last opened the doc at". A missing pref counts as unread
// on purpose: a fresh install shows the dot once until the first open.
const newestChangelogDate = /^##\s+(\d{4}-\d{2}-\d{2})/m.exec(changelogMd)?.[1] ?? null

export function isChangelogUnread(): boolean {
  return newestChangelogDate !== null && getPref('changelogSeen') !== newestChangelogDate
}

// The badge the "What's new" entry points (login footer, lobby menu) append to
// their label — '' while read, so callers can inline it in view templates.
// Views clear the rendered dots themselves after openChangelogDoc.
export function unreadDotHtml(extraClass = ''): string {
  if (!isChangelogUnread()) return ''
  return `<span class="unread-dot${extraClass ? ` ${extraClass}` : ''}"></span>`
}

export function openChangelogDoc(): void {
  if (newestChangelogDate !== null) setPref('changelogSeen', newestChangelogDate)
  openDocView("What's new", prep(changelogMd))
}

// The Gestures section of ABOUT.md, as its own small doc (Settings → Help).
// Extracted rather than duplicated so the list has one source of truth; if
// the section heading ever changes, fall back to the full About doc rather
// than showing nothing.
export function openGesturesDoc(): void {
  const section = /\n## Gestures\r?\n([\s\S]*?)(?=\n## |$)/.exec(aboutMd)
  if (section) openDocView('Gestures', section[1].trim())
  else openAboutDoc()
}
