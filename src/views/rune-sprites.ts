// One sprite pipeline for every rune/Orb drawing — the card's rune row and
// Orb trophy (built here), the doll marks (rune-marks.ts): a synchronous
// glyph placeholder — the ASCII-mode item glyph in the rune's colour
// (rune-tiles.ts runeGlyph) — and an async swap for the sprite once a
// source resolves.
//
// Sprite source, in order (the tile-decorations policy: a rune sprite is a
// rune sprite, whichever pack draws it):
//   1. the on-device offline tiles pack (same-origin → canvas-bakeable):
//      each rune bakes ONCE per pack build into the avatar-bake LRU (fixed
//      sprites, so ~20 bakes cover the feature for good) and thereafter
//      places from localStorage — airplane mode, pack eviction, dead
//      version dirs all fine;
//   2. the recipe's own doll atlas (resolvePlayerLoader): live DOM
//      tile-stacks off main.png — cross-origin, so never baked. main is the
//      largest atlas, loaded only when a sprite actually renders.
// No source = the glyph stays. Decoration-only, so missing is no harm.
import { cachedGamedataBuild } from '../offline/artifact-store'
import { resolvePlayerLoader } from '../game/tiles/atlas-dedup'
import { bakeDoll, bakedDollUrl, storeBakedDoll } from '../game/tiles/avatar-bake'
import { ORB, runeGlyph, runeLabel, runeTileRef } from '../game/tiles/rune-tiles'
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
  const cell = document.createElement('span')
  cell.className = 'rune-cell'
  cell.dataset.rune = word
  cell.title = runeLabel(word)
  cell.setAttribute('aria-label', runeLabel(word))
  cell.style.width = cell.style.height = `${32 * scale}px`
  const g = runeGlyph(word)
  const glyph = document.createElement('span')
  glyph.className = 'rune-glyph'
  glyph.textContent = g.ch
  glyph.style.color = DCSS_COLOR_MAP[g.colour] ?? ''
  glyph.style.fontSize = `${Math.round(26 * scale)}px`
  cell.append(glyph)
  return cell
}

// Swap a cell's glyph for its sprite under a resolved source. Never rejects;
// a failure leaves the glyph.
export async function fillRuneCell(cell: HTMLElement, src: RuneSource, scale: number): Promise<void> {
  try {
    const word = cell.dataset.rune!
    const el = await sourceSprite(src, `rune:${word}`, () => runeTileRef(src.loader, word), scale)
    if (el) cell.replaceChildren(el)
  } catch { /* glyph stays */ }
}

// One fixed sprite under a resolved source: baked-once off the local pack,
// a live tile-stack otherwise (the header's source policy). Also draws the
// offline lobby's scores-row icon, which is no rune but the same kind of
// fixed decoration. The bake is addressed by `name` (empty spec), never by
// tile index: an index costs a tileinfo module load (gui ~150 KB, main
// larger), so `ref` runs only on a bake miss and a placed sprite touches
// nothing but localStorage.
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
  return bakedImg(url, scale)
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

// The Orb of Zot as a single larger cell — the card's doll-column trophy.
export function renderOrbTrophy(recipe: DollRecipe | null | undefined, scale = 1): HTMLElement {
  const cell = runeCell(ORB, scale)
  void fillRuneCells([cell], recipe, scale)
  return cell
}
