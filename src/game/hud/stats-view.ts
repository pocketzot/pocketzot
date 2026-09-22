import type { PlayerMsg } from '../../ws/types'
import type { InventoryStore } from '../inventory-store'
import { escHtml, dcssToHtml, DCSS_COLOR_MAP } from '../dcss-colors'
import { compactPlace, nameTitle } from '../char-label'

const BAR_RES = 10000  // basis points; matches reference player.js precision

function indexToLetter(index: number): string {
  if (index < 0) return '-'
  if (index < 26) return String.fromCharCode(0x61 + index)
  return String.fromCharCode(0x41 + index - 26)
}

// Noise level → data-level category, mirroring update_bar_noise in player.js.
// The matching colors live in style.css (.hg-noise-cell[data-level=...]).
function noiseCat(level: number): string {
  if (level <= 333) return 'quiet'
  if (level <= 666) return 'loud'
  if (level < 1000) return 'veryloud'
  return 'superloud'
}

export class StatsView {
  private el: HTMLElement
  private state: Partial<PlayerMsg> = {}
  private inv: InventoryStore
  private prevTime: number | undefined
  private timeDelta = 0
  private oldNoise: number | undefined
  private oldHp: number | undefined
  private oldMp: number | undefined
  private layout: 'compact' | 'square'
  // stat_colour warning thresholds from the {msg:"options"} snapshot.
  // Seeded with crawl's default ("3:red" — the stat-zero proximity warning)
  // so a Spriggan's natural Str 3 reads red even if the options message
  // predates this view (it's sent once at process start).
  private statColour: Array<{ value: number; colour: string }> = [{ value: 3, colour: 'red' }]
  private mql: MediaQueryList | null
  private onPlaceTap: (() => void) | null = null
  private onSettingsTap: (() => void) | null = null

  constructor(inv: InventoryStore) {
    this.inv = inv
    this.el = document.createElement('div')
    this.el.id = 'hud-stats'
    // The place chip's tap surface. Delegated on the stable root because
    // render() rewrites the chip's markup each repaint — and kept HERE, next
    // to the templates that emit .hud-place-chip, so the selector and the
    // markup have a single owner (same principle as cellKey/parseCellKey in
    // map-store). Consumers get a callback, not knowledge of our DOM.
    this.el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement
      if (this.onPlaceTap && t.closest?.('.hud-place-chip')) this.onPlaceTap()
      else if (this.onSettingsTap && t.closest?.('.hud-settings-chip')) this.onSettingsTap()
    })
    // Portrait gets the compact HUD (single nowrap rows); landscape gets the
    // square two-column HUD, which fits the 15rem sidebar without clipping.
    // Same query string as the style.css landscape block so JS and CSS can
    // never disagree about which mode is active.
    this.mql = typeof window.matchMedia === 'function'
      ? window.matchMedia('(orientation: landscape)')
      : null
    this.layout = this.mql?.matches ? 'square' : 'compact'
    this.el.innerHTML = this.template()
    this.mql?.addEventListener('change', this.onOrientationChange)
  }

  get element(): HTMLElement {
    return this.el
  }

  setOnPlaceTap(cb: () => void): void {
    this.onPlaceTap = cb
  }

  setOnSettingsTap(cb: () => void): void {
    this.onSettingsTap = cb
  }

  // Swap templates on rotate and repaint from the accumulated state — render()
  // re-queries its slots every pass and both templates expose the same slot
  // ids, so the render methods are layout-agnostic. buildGameView creates a
  // fresh StatsView per game session with no dispose hook; the listener
  // detects its element has left the document and unhooks itself.
  private onOrientationChange = (): void => {
    if (!this.el.isConnected) {
      this.mql?.removeEventListener('change', this.onOrientationChange)
      return
    }
    const layout = this.mql?.matches ? 'square' : 'compact'
    if (layout === this.layout) return
    this.layout = layout
    this.el.innerHTML = this.template()
    this.render()
  }

  // {msg:"options"} handler. An empty/absent stat_colour list is a real
  // setting (stat_colour -= clears the warning), so any present array wins.
  setOptions(opts: Record<string, unknown>): void {
    const sc = opts['stat_colour']
    if (Array.isArray(sc)) {
      this.statColour = sc.filter((e): e is { value: number; colour: string } =>
        e != null && typeof e.value === 'number' && typeof e.colour === 'string')
      this.render()
    }
  }

  update(p: Partial<PlayerMsg>): void {
    if ('time' in p && p.time !== undefined) {
      if (this.prevTime !== undefined) {
        this.timeDelta = p.time - this.prevTime
      }
      this.prevTime = p.time
    }
    // Pre-0.33 equip deltas carry only the changed slots — merge key-wise so
    // e.g. a ring swap doesn't drop the stored weapon slot (reference does
    // $.extend(player.equip, data.equip)).
    if (p.equip) p = { ...p, equip: { ...this.state.equip, ...p.equip } }
    Object.assign(this.state, p)
    this.render()
  }

  private render(): void {
    const s = this.state
    const hp = s.hp ?? 0
    const hpMax = s.hp_max ?? 1
    const mp = s.mp ?? 0
    const mpMax = s.mp_max ?? 1

    const name = s.name ?? ''
    const title = s.title ?? ''
    // Display name carries subtype colour ("Red Draconian"); logic checks
    // below (Djinni, Deep Dwarf) key off the base `species` as the wire
    // guarantees that form, not the display one.
    const species = s.species ?? ''
    const speciesDisplay = s.species_display_name || species
    const god = s.god ?? ''
    const piety = s.piety_rank ?? 0
    const godStr = god && god !== 'No God' ? ` of ${god}` : ''
    const titled = nameTitle(name, title)
    // Wizard/explore games are non-scoring; flag them like the reference's
    // #stats_wizmode. Explore mode is reachable from the WebTiles lobby ('+').
    const modeFlag = s.wizard ? ' *WIZARD*' : s.explore ? ' *EXPLORE*' : ''
    const speciesGod = speciesDisplay + godStr
    const idEl = this.el.querySelector<HTMLElement>('#hud-id')
    if (idEl) {
      // compact: one combined line
      const idLine = titled && speciesGod ? `${titled} — ${speciesGod}` : titled || speciesGod
      idEl.textContent = idLine + modeFlag
    } else {
      // square: separate title and species lines, as in the reference
      // (#stats_titleline / #stats_species_god in game.html)
      this.setText('hud-title', titled + modeFlag)
      this.setText('hud-species', speciesGod)
    }

    // Piety row, mirroring the reference's three-way render (player.js):
    // Xom's rank is a *position* (mood meter), not a level — a lone star
    // sliding along dots, or all dots for the "very special plaything"
    // state (negative rank). Other gods get stars + dots, with trunk's
    // ostracism pips as red X's consuming trailing dots, shown for ANY
    // rank (dots-only at 0) so a fresh convert or penanced row stays
    // visible. Penance tints the whole row red via the CSS class.
    const pietyEl = this.el.querySelector<HTMLElement>('#hud-piety')
    if (pietyEl) {
      const pips = s.ostracism_pips ?? 0
      if (god === 'Xom') {
        pietyEl.textContent = piety >= 0
          ? '.'.repeat(piety) + '*' + '.'.repeat(Math.max(0, 5 - piety))
          : '......'
      } else if (god && god !== 'No God' && god !== 'Gozag') {
        pietyEl.innerHTML = escHtml('*'.repeat(piety) + '.'.repeat(Math.max(0, 6 - piety - pips)))
          + (pips > 0 ? `<span class="fg5">${escHtml('X'.repeat(pips))}</span>` : '')
      } else {
        pietyEl.textContent = ''
      }
      pietyEl.classList.toggle('penance', !!s.penance)
    }

    const realHpMax = s.real_hp_max
    const hpDrained = realHpMax != null && realHpMax !== hpMax
    const hpText = hpDrained
      ? `${hp}/${hpMax} (${realHpMax})`
      : `${hp}/${hpMax}`
    this.setText('hud-hp', hpText)

    // Djinni (whose HP is their casting pool) hide the Magic line entirely,
    // mirroring player.js hiding #stats_mpline. Both templates tag their MP
    // row #hud-mp-line, so this applies in portrait and landscape alike.
    const mpLine = this.el.querySelector<HTMLElement>('#hud-mp-line')
    if (mpLine) mpLine.style.display = species === 'Djinni' ? 'none' : ''
    // Square-only: the HP caption reads "Health:" until a drained "(real max)"
    // needs the room, then shortens to "HP:". Compact has no caption element,
    // so this no-ops there.
    const hpCap = this.el.querySelector<HTMLElement>('#hud-hp-caption')
    if (hpCap) hpCap.textContent = hpDrained ? 'HP:' : 'Health:'

    // dd_real_mp_max is sent as 0 for non-Deep-Dwarves; only show parens for DD with reduced max.
    const ddRealMpMax = s.dd_real_mp_max ?? 0
    const mpText = ddRealMpMax > 0 && ddRealMpMax !== mpMax
      ? `${mp}/${mpMax} (${ddRealMpMax})`
      : `${mp}/${mpMax}`
    this.setText('hud-mp', mpText)

    // Tint the HP/MP figure "boosted" (lightblue) while the relevant max is
    // magically inflated, mirroring player.js stat_boosters: HP under divinely
    // vigorous or berserk, MP under divinely vigorous. (The bar itself is
    // unchanged — this is only the numeric readout, as in the reference.)
    const statuses = s.status ?? []
    const hasStatus = (re: RegExp): boolean => statuses.some(st => st.text != null && re.test(st.text))
    this.el.querySelector('#hud-hp')?.classList.toggle('stat-boosted', hasStatus(/divinely vigorous|berserk/i))
    this.el.querySelector('#hud-mp')?.classList.toggle('stat-boosted', hasStatus(/divinely vigorous/i))

    this.renderStatValue('hud-str', s.str, s.str_max, 'str')
    this.renderStatValue('hud-int', s.int, s.int_max, 'int')
    this.renderStatValue('hud-dex', s.dex, s.dex_max, 'dex')

    this.renderDefenseValue('hud-ac', s.ac, s.ac_mod)
    this.renderDefenseValue('hud-ev', s.ev, s.ev_mod)
    this.renderDefenseValue('hud-sh', s.sh, s.sh_mod)

    this.renderWarnings()

    const xl = s.xl ?? '?'
    const place = s.place ?? ''
    const depth = s.depth
    const placeStr = depth ? `${place}:${depth}` : place
    const goldAura = (s.status ?? []).some(st => st.text === 'gold aura')
    const xlEl = this.el.querySelector<HTMLElement>('#hud-xl-place')
    if (xlEl) {
      // compact: XL/progress/place/gold composed onto one line
      let html = `<span class="hg-caption">XL</span><span>${escHtml(String(xl))}</span>`
      if (s.progress != null) html += ` ${escHtml(String(s.progress))}%`
      // Compact abbreviates the branch (D:5, Elf:3 — the lobby/morgue short
      // forms) to protect the line's tightest real estate; square keeps the
      // full name, as the reference does.
      if (placeStr) html += ` <span class="hud-place-chip"><span class="hg-caption">@</span><span>${escHtml(compactPlace(place, depth))}</span></span>`
      if (god === 'Gozag' && s.gold != null) {
        const valClass = goldAura ? ' class="stat-boosted"' : ''
        html += ` <span class="hg-caption">$</span><span${valClass}>${escHtml(String(s.gold))}</span>`
      }
      xlEl.innerHTML = html
    } else {
      // square: XL+Next pair with Place across the grid row (reference rows)
      this.setText('hud-xl', String(xl))
      this.setText('hud-prog', `${s.progress ?? 0}%`)
      this.setText('hud-place', placeStr)
    }

    // Square: Gozag gold rides the species line (reference
    // #stats_gozag_gold_label sits after piety there).
    const goldUi = this.el.querySelector<HTMLElement>('#hud-gold-ui')
    if (goldUi) {
      const showGold = god === 'Gozag' && s.gold != null
      goldUi.style.display = showGold ? '' : 'none'
      const goldEl = this.el.querySelector<HTMLElement>('#hud-gold')
      if (goldEl) {
        goldEl.textContent = showGold ? String(s.gold) : ''
        goldEl.classList.toggle('stat-boosted', goldAura)
      }
    }

    const time = s.time ?? 0
    const timeStr = (time / 10).toFixed(1) + (this.timeDelta > 0 ? ` (${(this.timeDelta / 10).toFixed(1)})` : '')
    this.setText('hud-time-val', timeStr)

    this.renderBar('hp', hp, hpMax, s.poison_survival)
    this.renderBar('mp', mp, mpMax, undefined)

    // Noise bar (graphical, mirrors update_bar_noise in player.js)
    this.renderNoiseBar(s.adjusted_noise ?? 0, hasStatus(/silenced?/i))

    // Weapon row (own line, ellipsis if too long)
    const wqRow = this.el.querySelector<HTMLElement>('#hud-wq')
    const weaponHtml = this.buildWeapon(false)
    if (wqRow) {
      wqRow.innerHTML = weaponHtml
      wqRow.style.display = weaponHtml ? '' : 'none'
    }

    // Offhand weapon row (dual-wield etc.) — only when server flags it.
    const offhandRow = this.el.querySelector<HTMLElement>('#hud-wq-offhand')
    if (offhandRow) {
      const offhandHtml = s.offhand_weapon ? this.buildWeapon(true) : ''
      offhandRow.innerHTML = offhandHtml
      offhandRow.style.display = offhandHtml ? '' : 'none'
    }

    // Quiver gets its own row directly below the weapon (console-style pairing)
    const quiverEl = this.el.querySelector<HTMLElement>('#hud-quiver')
    if (quiverEl) {
      const quiverHtml = dcssToHtml(s.quiver_desc ?? '')
      quiverEl.innerHTML = quiverHtml
      quiverEl.style.display = quiverHtml ? '' : 'none'
    }
  }

  // Mirrors update_bar() in webserver/game_data/static/player.js:21-67. Segments are
  // sized in basis points and applied as percent widths to four (HP) or three (MP)
  // sibling spans inside .hg-bar-cell. decrease/increase only show on the tick when
  // the value changes; on the next render with no change, both go back to 0.
  private renderBar(
    name: 'hp' | 'mp',
    value: number,
    max: number,
    poisonSurvival: number | undefined,
  ): void {
    value = Math.max(0, value)
    max = Math.max(1, max)
    const prevOld = name === 'hp' ? this.oldHp : this.oldMp
    const oldValue = Math.min(prevOld ?? value, max)
    if (name === 'hp') this.oldHp = value
    else this.oldMp = value

    const increase = oldValue < value
    let fullBar = Math.round(((increase ? oldValue : value) / max) * BAR_RES)
    let changeBar = Math.floor((Math.abs(oldValue - value) / max) * BAR_RES)
    let poisonBar = 0

    if (name === 'hp' && poisonSurvival != null && poisonSurvival < value) {
      poisonBar = Math.round(((value - poisonSurvival) / max) * BAR_RES)
      fullBar = Math.round((poisonSurvival / max) * BAR_RES)
    }

    if (fullBar + poisonBar + changeBar > BAR_RES) {
      changeBar = Math.max(0, BAR_RES - poisonBar - fullBar)
    }

    this.setSegWidth(`${name}-full`, fullBar)
    if (name === 'hp') this.setSegWidth('hp-poison', poisonBar)
    this.setSegWidth(`${name}-decrease`, increase ? 0 : changeBar)
    this.setSegWidth(`${name}-increase`, increase ? changeBar : 0)
  }

  private setSegWidth(cls: string, basisPoints: number): void {
    const el = this.el.querySelector<HTMLElement>(`.${cls}`)
    if (el) el.style.width = `${basisPoints / 100}%`
  }

  // Mirrors update_bar_noise() in player.js:69-139. adjusted_noise is already
  // rescaled server-side to 0–1000. The full segment is colored by level via a
  // data-level attribute (see style.css); the decrease segment shows the
  // receding tail in darkgray for one tick when noise drops. When silenced the
  // bar blanks to black and the caption reads "Silenced".
  private renderNoiseBar(level: number, silenced: boolean): void {
    const max = 1000
    if (level < 0) level = 0
    let oldValue = Math.min(this.oldNoise ?? level, max)
    let cat = noiseCat(level)
    if (silenced) {
      level = 0
      oldValue = 0
      cat = 'blank'
    }
    this.oldNoise = level

    const fullBar = Math.round((BAR_RES * level) / max)
    let changeBar = Math.round((BAR_RES * Math.abs(oldValue - level)) / max)
    if (fullBar + changeBar > BAR_RES) changeBar = BAR_RES - fullBar

    const cell = this.el.querySelector<HTMLElement>('#hud-noise-cell')
    if (cell) cell.setAttribute('data-level', cat)
    this.setSegWidth('noise-full', fullBar)
    // Reference shows the decrease tail whenever there was prior noise; we only
    // show it on an actual drop, matching the HP/MP decrease semantics and
    // avoiding a spurious tail when noise rises.
    this.setSegWidth('noise-decrease', level < oldValue ? changeBar : 0)

    // The "N" caption stays put; "Silenced" shows in a separate span to the
    // right of the (now-black) bar, mirroring the reference's #stats_noise_status
    // rather than hiding the caption. (game.html keeps <span class="stats_caption">
    // static; player.js only sets #stats_noise_status.)
    const status = this.el.querySelector<HTMLElement>('#hud-noise-status')
    if (status) status.textContent = silenced ? 'Silenced' : ''
  }

  private buildWeapon(offhand: boolean): string {
    const s = this.state
    // weapon_index/offhand_index exist since 0.33; older servers send the
    // same info in the equip map ("0" = weapon, "5" = shield/offhand), and
    // always send unarmed_attack — without the equip fallback that shows a
    // wielding player as unarmed ("Nothing wielded").
    const idx = (offhand ? s.offhand_index : s.weapon_index)
      ?? s.equip?.[offhand ? '5' : '0']
      ?? (s.unarmed_attack !== undefined ? -1 : undefined)
    if (idx === undefined) return ''

    // Era latch: state accumulates for the view's lifetime, so once a trunk
    // server has sent weapon_colour it stays present (see PlayerMsg). Trunk
    // also stopped painting corroded weapons (b51359a412 — corrosion is a
    // plain slaying malus now, player.js has no corroded_weapon class), so
    // the red is ≤0.34-only.
    const trunkColours = 'weapon_colour' in s
    const trunkCol = offhand ? s.offhand_weapon_colour : s.weapon_colour
    const corroded = !trunkColours && (s.status ?? []).some(st => st.text === 'corroded')
    const classes: string[] = []

    let name: string
    let col: number | undefined
    if (idx === -1) {
      name = s.unarmed_attack ?? ''
      col = trunkColours ? trunkCol : (s.unarmed_attack_colour ?? 7)
    } else {
      const item = this.inv.get(idx)
      if (!item) return ''
      name = item.name ?? ''
      // ≤0.34 fallback is the inventory menu_colour, which isn't refreshed on
      // equip — the bug the trunk fields fix; don't "improve" it client-side.
      col = trunkColours ? trunkCol : item.col
    }
    // Reference omits the .fgN class when col is -1 or null (defaults to lightgrey).
    if (col != null && col >= 0) classes.push(`fg${col & 0xf}`)
    if (corroded) classes.push('weapon-corroded')

    const letter = idx === -1 ? '-' : indexToLetter(idx)
    const classAttr = classes.length ? ` class="${classes.join(' ')}"` : ''
    return `<span class="hg-caption">${letter})</span> <span${classAttr}>${escHtml(name)}</span>`
  }

  // Mirrors stat_class() in player.js: lost (status) → stat_colour warning
  // threshold (first entry the value is at or under; a colour, not a class)
  // → boosted (status) → drained (current < max) → normal.
  private statClass(stat: 'str' | 'int' | 'dex', val: number, max: number): { cls?: string; color?: string } {
    const statuses = this.state.status ?? []
    const lostRe = new RegExp(`lost ${stat}`, 'i')
    if (statuses.some(st => st.text && lostRe.test(st.text))) return { cls: 'stat-zero' }
    for (const t of this.statColour) {
      // Unknown colour names fall through as-is: every DCSS colour name the
      // option accepts is also a valid-enough CSS keyword to fail soft.
      if (val <= t.value) return { color: DCSS_COLOR_MAP[t.colour] ?? t.colour }
    }
    if (statuses.some(st => st.text && /vitalised/i.test(st.text))) return { cls: 'stat-boosted' }
    if (val < max) return { cls: 'stat-degenerated' }
    return {}
  }

  // Mirrors update_stat() in player.js: append " (max)" when the stat is drained
  // below its natural maximum, and colour the value accordingly.
  private renderStatValue(id: string, val: number | undefined, max: number | undefined, stat: 'str' | 'int' | 'dex'): void {
    const el = this.el.querySelector<HTMLElement>(`#${id}`)
    if (!el) return
    const v = val ?? 0
    const m = max ?? v
    // Drained: tuck the "(max)" tight against the value via .stat-max's margin
    // (a small fixed gap), rather than a full space, so the readout stays compact.
    if (v < m) el.innerHTML = `${v}<span class="stat-max">(${m})</span>`
    else el.textContent = String(v)
    el.classList.remove('stat-boosted', 'stat-zero', 'stat-degenerated')
    const st = this.statClass(stat, v, m)
    if (st.cls) el.classList.add(st.cls)
    el.style.color = st.color ?? ''
  }

  // Contamination and Doom, mirroring update_contam/update_doom in player.js.
  // Both are shown only when nonzero (reference hides them at 0 unless
  // always_show_doom_contam is set) and coloured by severity.
  // Compact: joined at the right end of the stats row (hidden when empty via
  // .hg-warn:empty) — the prominent slot, since they're active danger meters.
  // Square: Doom rides the Str row and Contam the Int row, matching the
  // reference's #stats_doom_ui / #stats_contam_ui placement in game.html.
  private renderWarnings(): void {
    const contam = this.state.contam ?? 0
    const doom = this.state.doom ?? 0
    const contamCls = contam >= 200 ? 'fg4' : contam >= 100 ? 'fg14' : 'fg8'
    const doomCls = doom >= 75 ? 'fg5' : doom >= 50 ? 'fg12' : doom >= 25 ? 'fg14' : 'fg7'

    const joined = this.el.querySelector<HTMLElement>('#hud-warn')
    if (joined) {
      const parts: string[] = []
      if (contam > 0) {
        parts.push(`<span class="hg-grp"><span class="hg-caption">Contam</span><span class="${contamCls}">${contam}%</span></span>`)
      }
      if (doom > 0) {
        parts.push(`<span class="hg-grp"><span class="hg-caption">Doom</span><span class="${doomCls}">${doom}%</span></span>`)
      }
      // Joined with a space so the Contam↔Doom gap matches the inter-stat gap
      // (e.g. AC↔EV) — .hg-warn applies the same word-spacing to that space.
      joined.innerHTML = parts.join(' ')
      return
    }

    const setWarn = (ui: string, val: string, value: number, cls: string): void => {
      const uiEl = this.el.querySelector<HTMLElement>(`#${ui}`)
      if (!uiEl) return
      uiEl.style.display = value > 0 ? '' : 'none'
      const valEl = this.el.querySelector<HTMLElement>(`#${val}`)
      if (valEl) {
        valEl.textContent = value > 0 ? `${value}%` : ''
        valEl.className = cls
      }
    }
    setWarn('hud-doom-ui', 'hud-doom', doom, doomCls)
    setWarn('hud-contam-ui', 'hud-contam', contam, contamCls)
  }

  private renderDefenseValue(id: string, val: number | undefined, mod: number | undefined): void {
    const el = this.el.querySelector<HTMLElement>(`#${id}`)
    if (!el) return
    el.textContent = String(val ?? 0)
    el.classList.toggle('def-boosted', (mod ?? 0) > 0)
    el.classList.toggle('def-degenerated', (mod ?? 0) < 0)
  }

  private setText(id: string, text: string): void {
    const el = this.el.querySelector<HTMLElement>(`#${id}`)
    if (el) el.textContent = text
  }

  private template(): string {
    return this.layout === 'square' ? this.squareTemplate() : this.compactTemplate()
  }

  // The in-game Settings entry: a self-labeling gear parked at the right edge
  // of the id line (same delegated-tap hook as the place chip, via
  // setOnSettingsTap). It stays visibly tappable — it's the one surface a lost
  // player must find without first reading the Gestures help, which itself
  // lives inside Settings.
  private settingsChip(): string {
    // U+2699 GEAR + U+FE0E (text-presentation selector): iOS Safari otherwise
    // renders the bare gear as a colour emoji, ignoring the CSS colour. FE0E
    // forces the monochrome glyph so it inherits the fg14 line colour.
    return `<span class="hud-settings-chip" role="button" aria-label="Settings" title="Settings">&#x2699;&#xFE0E;</span>`
  }

  private wqQuiverRows(): string {
    return `
      <div class="hg-wq" id="hud-wq"></div>
      <div class="hg-wq" id="hud-wq-offhand"></div>
      <div class="hg-quiver" id="hud-quiver"></div>
    `
  }

  private compactTemplate(): string {
    return `
      <div class="hs-id fg14"><span id="hud-id"></span><span class="hg-piety" id="hud-piety"></span>${this.settingsChip()}</div>
      <div class="hg-bar-pair">
        <div class="hg-bar-row hg-hp">
          <div class="hg-bar-cell"><span class="hud-bar-seg hp-full"></span><span class="hud-bar-seg hp-poison"></span><span class="hud-bar-seg hp-decrease"></span><span class="hud-bar-seg hp-increase"></span></div>
          <span class="hg-bar-val" id="hud-hp"></span>
        </div>
        <div class="hg-bar-row hg-mp" id="hud-mp-line">
          <div class="hg-bar-cell"><span class="hud-bar-seg mp-full"></span><span class="hud-bar-seg mp-decrease"></span><span class="hud-bar-seg mp-increase"></span></div>
          <span class="hg-bar-val" id="hud-mp"></span>
        </div>
      </div>
      <div class="hg-stats-row">
        <div class="hg-inline-stats">
          <span class="hg-grp"><span class="hg-caption">AC</span><span id="hud-ac"></span> <span class="hg-caption">EV</span><span id="hud-ev"></span> <span class="hg-caption">SH</span><span id="hud-sh"></span></span>
          <span class="hg-grp"><span class="hg-caption">St</span><span id="hud-str"></span> <span class="hg-caption">In</span><span id="hud-int"></span> <span class="hg-caption">Dx</span><span id="hud-dex"></span></span>
        </div>
        <span class="hg-warn" id="hud-warn"></span>
      </div>
      <div class="hg-xl-row">
        <span class="hg-xl-place hg-grp" id="hud-xl-place"></span>
        <span class="hg-noise-time">
          <span class="hg-noise"><span class="hg-caption">N</span><span class="hg-noise-cell" id="hud-noise-cell"><span class="hud-bar-seg noise-full"></span><span class="hud-bar-seg noise-decrease"></span></span><span class="hg-noise-status" id="hud-noise-status"></span></span>
          <span class="hg-time"><span class="hg-caption">T</span><span id="hud-time-val"></span></span>
        </span>
      </div>
      ${this.wqQuiverRows()}
    `
  }

  // Square HUD for the landscape sidebar, mirroring the reference stats panel
  // (game.html #stats): title and species/god/gold lines, Health/Magic
  // caption lines with right-anchored bars, then a 45/55 two-column block
  // pairing AC|Str, EV|Int, SH|Dex, XL+Next|Place, Noise|Time — Doom and
  // Contam ride the Str/Int rows as in the reference — and full-width
  // weapon/quiver rows. Every readout owns a cell, so nothing clips at
  // sidebar width the way the compact template's nowrap rows do.
  private squareTemplate(): string {
    return `
      <div class="hs-id fg14"><span id="hud-title"></span>${this.settingsChip()}</div>
      <div class="hs-species fg14"><span id="hud-species"></span><span class="hg-piety" id="hud-piety"></span><span class="hud-sq-gold" id="hud-gold-ui" style="display:none"><span class="hg-caption">Gold:</span><span id="hud-gold"></span></span></div>
      <div class="hg-bar-row hud-sq-barline">
        <span class="hg-caption" id="hud-hp-caption">Health:</span>
        <span class="hg-bar-val" id="hud-hp"></span>
        <div class="hg-bar-cell"><span class="hud-bar-seg hp-full"></span><span class="hud-bar-seg hp-poison"></span><span class="hud-bar-seg hp-decrease"></span><span class="hud-bar-seg hp-increase"></span></div>
      </div>
      <div class="hg-bar-row hud-sq-barline" id="hud-mp-line">
        <span class="hg-caption">Magic:</span>
        <span class="hg-bar-val" id="hud-mp"></span>
        <div class="hg-bar-cell"><span class="hud-bar-seg mp-full"></span><span class="hud-bar-seg mp-decrease"></span><span class="hud-bar-seg mp-increase"></span></div>
      </div>
      <div class="hud-grid">
        <span><span class="hg-caption">AC:</span><span id="hud-ac"></span></span>
        <span><span class="hg-caption">Str:</span><span id="hud-str"></span><span class="hud-sq-warn" id="hud-doom-ui" style="display:none"><span class="hg-caption">Doom:</span><span id="hud-doom"></span></span></span>
        <span><span class="hg-caption">EV:</span><span id="hud-ev"></span></span>
        <span><span class="hg-caption">Int:</span><span id="hud-int"></span><span class="hud-sq-warn" id="hud-contam-ui" style="display:none"><span class="hg-caption">Contam:</span><span id="hud-contam"></span></span></span>
        <span><span class="hg-caption">SH:</span><span id="hud-sh"></span></span>
        <span><span class="hg-caption">Dex:</span><span id="hud-dex"></span></span>
        <span><span class="hg-caption">XL:</span><span id="hud-xl"></span> <span class="hg-caption">Next:</span><span id="hud-prog"></span></span>
        <span class="hud-place-chip"><span class="hg-caption">Place:</span><span id="hud-place"></span></span>
        <span class="hg-noise"><span class="hg-caption">Noise:</span><span class="hg-noise-cell" id="hud-noise-cell"><span class="hud-bar-seg noise-full"></span><span class="hud-bar-seg noise-decrease"></span></span><span class="hg-noise-status" id="hud-noise-status"></span></span>
        <span class="hg-time"><span class="hg-caption">Time:</span><span id="hud-time-val"></span></span>
      </div>
      ${this.wqQuiverRows()}
    `
  }
}
