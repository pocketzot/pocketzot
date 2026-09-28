// Test-only: reads what the game view shows the player, as one line of
// text, from the DOM alone. The screen-trace goldens pin these lines per
// captured frame, so a restructure of game-view's internals must reproduce
// the same trace. When a restructure changes the DOM, adapt this probe in
// the same commit; the trace itself must not change.

const VIEW_CLASSES = ['x-mode', 'menu-bar', 'more-active', 'newgame', 'spell-row', 'spectating']

// Inline display:none or [hidden] on the element or any ancestor below
// the root. happy-dom does no layout, and the view hides by inline style.
function shown(el: Element | null, root: Element): boolean {
  for (let e = el; e && e !== root.parentElement; e = e.parentElement) {
    if (e instanceof HTMLElement && (e.style.display === 'none' || e.hidden)) return false
  }
  return !!el
}

const clip = (s: string, n = 48): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

function overlayState(view: HTMLElement): string {
  const ov = view.querySelector<HTMLElement>('#ui-overlay')
  if (!ov || !shown(ov, view)) return 'overlay:none'
  const parts: string[] = []
  const mode = ov.classList.contains('overlay-float') ? 'float' : 'full'
  const flags = ['prompt-menu', 'prompt-menu-alert'].filter(c => ov.classList.contains(c))
  parts.push(`overlay:${mode}${flags.length ? `(${flags.join(',')})` : ''}`)
  // The opening words tell screens apart (title, or body when untitled).
  // Footer and item rows are read separately below.
  const text = clip(ov.textContent ?? '', 40)
  if (text) parts.push(`text="${text}"`)
  const crt = ov.querySelector('#crt-display')
  if (crt && shown(crt, view)) {
    const rows = [...crt.querySelectorAll('.crt-line')]
    const first = rows.find(r => (r.textContent ?? '').trim())
    parts.push(`crt rows=${rows.length} first="${clip(first?.textContent ?? '')}"`)
  }
  const items = [...ov.querySelectorAll('.overlay-item')].filter(el => shown(el, view))
  if (items.length) {
    const hover = items.findIndex(el => el.classList.contains('item-hovered'))
    parts.push(`items=${items.length}${hover >= 0 ? ` hover=${hover}` : ''}`)
  }
  if (ov.querySelector('.dialog-body')) parts.push('dialog')
  const field = ov.querySelector<HTMLInputElement>('.input-dialog-field, .seed-input-field')
  if (field && shown(field, view)) parts.push(`field="${field.value}"`)
  const footer = ov.querySelector('.menu-footer, .overlay-footer')
  if (footer && shown(footer, view) && footer.textContent?.trim()) parts.push(`footer="${clip(footer.textContent)}"`)
  return parts.join(' ')
}

export function probeScreen(view: HTMLElement): string {
  const vis = (sel: string): boolean => shown(view.querySelector(sel), view)
  const shownParts = [
    ['map', '#map-grid'], ['log', '#game-messages'], ['hud', '#game-hud'],
    ['touch', '#touch-controls'], ['bar', '#menu-controls'],
  ].filter(([, sel]) => vis(sel)).map(([k]) => {
    if (k !== 'bar') return k
    const labels = [...view.querySelectorAll('#menu-controls .menu-ctrl-btn')]
      .filter(b => shown(b, view)).map(b => (b.textContent ?? '').trim())
    return `bar[${labels.join(' ')}]`
  })
  const classes = VIEW_CLASSES.filter(c => view.classList.contains(c))
  const parts = [overlayState(view), `shows:${shownParts.join(',') || '-'}`]
  if (classes.length) parts.push(`view:${classes.join(',')}`)
  const touchModes = ['cursor-mode', 'overlay-mode']
    .filter(c => view.querySelector('#touch-controls')?.classList.contains(c))
  if (touchModes.length) parts.push(`touch:${touchModes.join(',')}`)
  // The ASCII grid is row divs of cell spans; the cursor is a class on one.
  const cur = view.querySelector('#map-grid .map-cursor')
  if (cur?.parentElement?.parentElement) {
    const col = [...cur.parentElement.children].indexOf(cur)
    const row = [...cur.parentElement.parentElement.children].indexOf(cur.parentElement)
    parts.push(`cursor@${col},${row}`)
  }
  if (vis('#more-btn')) parts.push('more')
  // Answered prompt rows stay in the log with their buttons disabled; only
  // a row with live buttons is a prompt on screen.
  const live = [...view.querySelectorAll('#game-messages .game-prompt')]
    .filter(r => r.querySelector('button:not([disabled])') && shown(r, view))
  const prompt = live[live.length - 1]
  if (prompt) {
    const keys = prompt.querySelectorAll('button:not([disabled])').length
    parts.push(`prompt[${keys}]="${clip(prompt.textContent ?? '')}"`)
  }
  if (view.querySelector('#game-messages .game-text-input-row')) parts.push('textinput')
  return parts.join(' | ')
}

// One-line label for a server frame in the trace: its msg plus the fields
// that tell same-msg frames apart.
export function frameLabel(m: Record<string, unknown>): string {
  const bits = [String(m.msg)]
  for (const k of ['type', 'tag', 'layer', 'mode', 'id', 'cutoff']) {
    const v = m[k]
    if ((typeof v === 'string' && v) || typeof v === 'number') bits.push(`${k}=${v}`)
  }
  const title = (m.title as { text?: string } | undefined)?.text
  if (typeof title === 'string' && title) bits.push(`"${clip(title.replace(/<[^>]*>/g, ''), 32)}"`)
  if (Array.isArray(m.items)) bits.push(`items=${m.items.length}`)
  return bits.join(' ')
}
