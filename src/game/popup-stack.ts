// The engine's popup stack, mirrored: TilesFramework::m_menu_stack
// (tileweb.cc) is ONE ordered list of MENU, CRT and UI frames, and the wire
// pops whichever frame is on top — pop_menu sends close_menu, pop_ui_layout
// sends ui-pop, neither checks the frame's kind. The reference client keeps
// the same single order in its #ui-stack DOM (ui.js show_popup/hide_popup).
// What the game view paints is a function of this stack: the top frame,
// unless ui_cutoff hides it. No DOM.
//
// ui_cutoff (push/pop_ui_cutoff): the engine's stack depth when targeting,
// the level map or item adjust started under the open popups (directn.cc,
// viewmap.cc, adjust.cc cutoff_point). Frames at depth <= cutoff stay open
// server-side but hidden so the map shows through; frames pushed later sit
// above it and show. -1 = none. The reference applies it by toggling the
// popups present when the cutoff arrives (game.js handle_set_ui_cutoff),
// which is the same set.

export type PopupFrame<M, U> =
  | { kind: 'menu'; menu: M }
  // A CRT screen's text arrives separately, as txt lines keyed by row.
  | { kind: 'crt'; tag?: string; lines: Map<number, string> }
  | { kind: 'ui'; push: U }

export class PopupStack<M, U> {
  private readonly frames: PopupFrame<M, U>[] = []
  cutoff = -1

  get depth(): number { return this.frames.length }
  get empty(): boolean { return this.frames.length === 0 }

  top(): PopupFrame<M, U> | undefined {
    return this.frames[this.frames.length - 1]
  }

  // The frame directly under the top one.
  below(): PopupFrame<M, U> | undefined {
    return this.frames[this.frames.length - 2]
  }

  includes(frame: object): boolean {
    return (this.frames as object[]).includes(frame)
  }

  // The frame under the top one, or undefined when there is none or the
  // cutoff covers it.
  visibleBelow(): PopupFrame<M, U> | undefined {
    return this.covers(this.frames.length - 1) ? undefined : this.below()
  }

  // Whether a frame at this depth (1-based) is under the cutoff.
  private covers(depth: number): boolean {
    return this.cutoff >= 0 && depth <= this.cutoff
  }

  hidesAll(): boolean {
    return this.covers(this.frames.length)
  }

  has(kind: PopupFrame<M, U>['kind']): boolean {
    return this.frames.some((f) => f.kind === kind)
  }

  // The topmost frame of a kind, wherever it sits in the stack.
  topMenu(): M | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i]
      if (f.kind === 'menu') return f.menu
    }
    return undefined
  }

  topUi(): U | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i]
      if (f.kind === 'ui') return f.push
    }
    return undefined
  }

  topCrt(): Extract<PopupFrame<M, U>, { kind: 'crt' }> | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i]
      if (f.kind === 'crt') return f
    }
    return undefined
  }

  // `replace` (Menu::webtiles_write_menu) re-sends the top menu in place.
  // No trunk or 0.34.1 caller sets it; the old help menu did until the
  // formatted-scroller rewrite (crawl a02aae867c).
  pushMenu(menu: M, replace = false): void {
    if (replace && this.top()?.kind === 'menu') this.frames.pop()
    this.frames.push({ kind: 'menu', menu })
  }

  pushCrt(tag?: string): void {
    this.frames.push({ kind: 'crt', tag, lines: new Map() })
  }

  pushUi(push: U): void {
    this.frames.push({ kind: 'ui', push })
  }

  // close_menu and ui-pop alike.
  pop(): PopupFrame<M, U> | undefined {
    return this.frames.pop()
  }

  // close_all_menus, a ui-stack snapshot's reset, layer:"game".
  clear(): void {
    this.frames.length = 0
    this.cutoff = -1
  }
}
