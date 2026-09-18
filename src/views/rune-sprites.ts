// One sprite pipeline for every rune/Orb/gem drawing — the card's rune and
// gem rows and Orb trophy (built here), the doll marks (rune-marks.ts): a
// synchronous glyph placeholder — the ASCII-mode item glyph in the item's
// colour (rune-tiles.ts runeGlyph, gem-tiles.ts gemGlyph) — and an async
// swap for the sprite once a source resolves.
//
// Sprite source, in order (the tile-decorations policy: a rune sprite is a
// rune sprite, whichever pack draws it):
//   1. the on-device offline tiles pack (same-origin → canvas-bakeable):
//      each sprite bakes ONCE per pack build into the avatar-bake LRU (fixed
//      sprites, so ~35 bakes cover the feature for good) and thereafter
//      places from localStorage — airplane mode, pack eviction, dead
//      version dirs all fine;
//   2. the recipe's own doll atlas (resolvePlayerLoader): live DOM
//      tile-stacks off main.png — cross-origin, so never baked. main is the
//      largest atlas, loaded only when a sprite actually renders.
// No source = the glyph stays. Decoration-only, so missing is no harm.
import { cachedGamedataBuild } from '../offline/artifact-store'
import { resolvePlayerLoader } from '../game/tiles/atlas-dedup'
import { bakeDoll, bakedDollUrl, dropBakedDoll, storeBakedDoll } from '../game/tiles/avatar-bake'
import { ORB, runeGlyph, runeLabel, runeTileName, runeTileRef } from '../game/tiles/rune-tiles'
import { gemGlyph, gemLabel, gemTileName, gemTileRef } from '../game/tiles/gem-tiles'
import { getTileLoader, type TileLoader } from '../game/tiles/tile-loader'
import { DCSS_COLOR_MAP } from '../game/dcss-colors'
import { renderTiles, type TileRef } from '../game/tiles/tile-view'
import { bakedImg, type DollRecipe } from './avatar-tiles'

export interface RuneSource { loader: TileLoader; bakeFp: string | null }

export async function resolveRuneSource(recipe: DollRecipe | null | undefined): Promise<RuneSource | null> {
  try {
    const build = await cachedGamedataBuild()
    if (build) return { loader: getTileLoader('', 'local'), bakeFp: `runes#${build}` }
  } catch { /* fall through to the recipe's atlas */ }
  if (!recipe) return null
  try {
    const loader = await resolvePlayerLoader(recipe.httpBase, recipe.version)
    return loader ? { loader, bakeFp: null } : null
  } catch {
    return null
  }
}

// The placeholder: a labelled cell holding the glyph, sized like the sprite
// it stands in for (CELL × scale) so the layout never shifts on swap.
export function runeCell(word: string, scale: number): HTMLElement {
  return collectibleCell('rune', word, scale)
}

// A gem through the same cell → sprite pipeline. Gem and rune adjectives are
// separate namespaces ("mossy" is both — gem-tiles.ts), so the cell records
// which it is: `data-gem` vs `data-rune`.
export function gemCell(word: string, scale: number): HTMLElement {
  return collectibleCell('gem', word, scale)
}

type Kind = 'rune' | 'gem'

// `tileName` doubles as the bake name; null = no sprite, the glyph stays.
const KINDS = {
  rune: { label: runeLabel, glyph: runeGlyph, tileName: runeTileName, tileRef: runeTileRef },
  gem: { label: gemLabel, glyph: gemGlyph, tileName: gemTileName, tileRef: gemTileRef },
} satisfies Record<Kind, {
  label(word: string): string
  glyph(word: string): { ch: string; colour: string }
  tileName(word: string): string | null
  tileRef(loader: TileLoader, word: string): Promise<TileRef | null>
}>

function collectibleCell(kind: Kind, word: string, scale: number): HTMLElement {
  const cell = document.createElement('span')
  cell.className = 'rune-cell'
  cell.dataset[kind] = word
  const label = KINDS[kind].label(word)
  cell.title = label
  cell.setAttribute('aria-label', label)
  cell.style.width = cell.style.height = `${32 * scale}px`
  cell.append(glyphEl(kind, word, scale))
  return cell
}

function glyphEl(kind: Kind, word: string, scale: number): HTMLElement {
  const g = KINDS[kind].glyph(word)
  const glyph = document.createElement('span')
  glyph.className = 'rune-glyph'
  glyph.textContent = g.ch
  glyph.style.color = DCSS_COLOR_MAP[g.colour] ?? ''
  glyph.style.fontSize = `${Math.round(26 * scale)}px`
  return glyph
}

// Swap a cell's glyph for its sprite under a resolved source. Never rejects;
// a failure leaves the glyph. The bake name is the TILE's (runeTileName — a
// pure lookup, no module load), so every unknown adjective shares the one
// generic-rune bake instead of storing a copy each.
export async function fillRuneCell(cell: HTMLElement, src: RuneSource, scale: number): Promise<void> {
  try {
    const kind: Kind = cell.dataset.gem != null ? 'gem' : 'rune'
    const word = cell.dataset[kind]!
    const k = KINDS[kind]
    const tile = k.tileName(word)
    if (!tile) return // an unknown gem: no generic tile (gem-tiles.ts)
    const el = await sourceSprite(src, `main:${tile}`, () => k.tileRef(src.loader, word), scale)
    if (!el) return
    // sourceSprite's self-heal removes a bake that fails to decode; the cell
    // is fixed-size, so put the glyph back rather than leave a blank hole.
    el.addEventListener('error', () => cell.replaceChildren(glyphEl(kind, word, scale)))
    cell.replaceChildren(el)
  } catch { /* glyph stays */ }
}

// One fixed sprite under a resolved source: baked-once off the local pack,
// a live tile-stack otherwise (the header's source policy). Also draws the
// offline lobby's scores-row icon, which is no rune but the same kind of
// fixed decoration. The bake is addressed by `name` (empty spec), never by
// tile index: an index costs a tileinfo module load — for gui, 156 KB plus
// the tileinfo-player it define()s a dependency on (475 KB) — so `ref` runs
// only on a bake miss and a placed sprite touches nothing but localStorage.
// (The miss also decodes the atlas — gui.png is 718 KB — once per build.)
export async function sourceSprite(
  src: RuneSource, name: string, ref: () => Promise<TileRef | null>, scale: number,
): Promise<HTMLElement | null> {
  if (!src.bakeFp) {
    const r = await ref()
    return r ? renderTiles(src.loader, [r], scale) : null
  }
  const fp = `${src.bakeFp}:${name}`
  let url = bakedDollUrl(fp, [])
  if (url == null) {
    const r = await ref()
    if (!r) return null
    url = await bakeDoll(src.loader, [r])
    if (url == null) return null
    storeBakedDoll(fp, [], url)
  }
  const img = bakedImg(url, scale)
  // A stored data-URL that no longer decodes is dropped and the broken <img>
  // removed, so the next paint re-bakes instead of serving the bad URL for
  // the pack build's lifetime (dolls: paintAvatars). What the emptied host
  // shows is the caller's business — the lobby boxes collapse, rune cells
  // restore their glyph (fillRuneCell).
  img.addEventListener('error', () => {
    dropBakedDoll(fp, [])
    img.remove()
  })
  return img
}

// Resolve once, fill every cell.
export async function fillRuneCells(cells: readonly HTMLElement[], recipe: DollRecipe | null | undefined, scale: number): Promise<void> {
  if (cells.length === 0) return
  const src = await resolveRuneSource(recipe)
  if (!src) return
  await Promise.all(cells.map((c) => fillRuneCell(c, src, scale)))
}

// --- Card surfaces ---------------------------------------------------------------

// 24px cells: legible sprite detail at phone width, and 15 runes wrap to two
// lines inside the card body.
const ROW_SCALE = 0.75

// The collection as a row on character cards (char-card.ts appends it; the
// crypt modal and offline records both go through that): one cell per rune
// in stored order, wrapping. The Orb is NOT in the row — the card shows it
// as the trophy under the doll (renderOrbTrophy).
export function renderRuneRow(runes: readonly string[], opts: { recipe?: DollRecipe | null } = {}): HTMLElement {
  const row = document.createElement('div')
  row.className = 'rune-row'
  const cells = runes.map((w) => runeCell(w, ROW_SCALE))
  row.append(...cells)
  void fillRuneCells(cells, opts.recipe, ROW_SCALE)
  return row
}

// The gems as a second row under the runes (char-card.ts): named gems in
// stored order, then a text chip for the ones the source counted but could
// not name (unnamedGems) — never a sprite, see gem-tiles.ts on GEM_GENERIC —
// then the quiet intact note where a source states it (offline xlog only).
export function renderGemRow(
  gems: readonly string[], opts: { total?: number; note?: string; recipe?: DollRecipe | null } = {},
): HTMLElement {
  const row = document.createElement('div')
  row.className = 'rune-row gem-row'
  const cells = gems.map((w) => gemCell(w, ROW_SCALE))
  row.append(...cells)
  const more = unnamedGems(gems, opts.total)
  if (more > 0) {
    const chip = document.createElement('span')
    chip.className = 'gem-row-more'
    chip.textContent = gems.length ? `+${more}` : `${more} gem${more > 1 ? 's' : ''}`
    chip.title = `${more} more found, not named in this record`
    row.append(chip)
  }
  if (opts.note) {
    const note = document.createElement('span')
    note.className = 'gem-row-note'
    note.textContent = opts.note
    row.append(note)
  }
  void fillRuneCells(cells, opts.recipe, ROW_SCALE)
  return row
}

// How many of a stated count the named list doesn't cover — online, a gem
// picked up on another client; offline, a record whose morgue and avatar
// entry are both gone (see AvatarMeta.gems).
export function unnamedGems(gems: readonly string[], total?: number): number {
  return Math.max(0, (total ?? 0) - gems.length)
}

// The Orb of Zot as a single larger cell — the card's doll-column trophy.
export function renderOrbTrophy(recipe: DollRecipe | null | undefined, scale = 1): HTMLElement {
  const cell = runeCell(ORB, scale)
  void fillRuneCells([cell], recipe, scale)
  return cell
}
