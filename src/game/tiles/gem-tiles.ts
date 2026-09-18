// Gem adjective → main-atlas tile const; the gem twin of rune-tiles.ts (same
// by-NAME lookup through the version's own tileinfo-main). Adjectives are
// item-prop.cc Gem_prop's `adj` column — the word in the pickup message, the
// morgue note and the `}` gems view, identical in 0.34.1 and trunk
// (glittering/GEM_ORC is TAG_MAJOR 34 only). Tile consts are rltiles
// dc-item.txt `item/gem` (`<branch>_found_whole`); each has a `_found_broken`
// twin at +1 that the engine itself draws only under `more_gem_info`
// (tilepick.cc _tileidx_gem) — a found gem stays whole here too, shattered
// or not. Gotcha: "mossy" is ALSO the removed forest rune's adjective
// (rune-tiles.ts) — gem and rune words are separate namespaces, never one
// lookup. An unknown word (a future gem) gets no sprite — its ♦ glyph stays.
// Never fall back to GEM_GENERIC: it is dc-item.txt `generic_unfound`, what
// the `}` gems view draws for a gem NOT found (tilepick.cc _tileidx_gem_base,
// quantity 0) — on a trophy row it says the opposite of the truth.
import { TEX, type TileLoader } from './tile-loader'
import type { TileRef } from './tile-view'

const GEM_TILE: Record<string, string> = {
  smoky: 'GEM_DUNGEON',
  glittering: 'GEM_ORC',
  shimmering: 'GEM_ELF',
  earthy: 'GEM_LAIR',
  mossy: 'GEM_SWAMP',
  azure: 'GEM_SHOALS',
  jade: 'GEM_SNAKE',
  'milky-white': 'GEM_SPIDER',
  starry: 'GEM_SLIME',
  shining: 'GEM_VAULTS',
  ivory: 'GEM_CRYPT',
  sanguine: 'GEM_TOMB',
  midnight: 'GEM_DEPTHS',
  prismatic: 'GEM_ZOT',
}

export function gemTileName(word: string): string | null {
  return GEM_TILE[word] ?? null
}

export function gemLabel(word: string): string {
  return word ? `${word} gem` : 'gem'
}

export async function gemTileRef(loader: TileLoader, word: string): Promise<TileRef | null> {
  const name = gemTileName(word)
  if (!name) return null
  const t = (await loader.getModule('main'))[name]
  return typeof t === 'number' ? { t, tex: TEX.MAIN } : null
}

// ASCII stand-in: DCHAR_ITEM_GEM '♦' U+2666 (viewchar.cc dchar_table) in the
// gem's own colour (items.cc item_def::gem_colour — element colours reduced
// to their first component, as rune-tiles.ts does; prismatic's ETC_RANDOM
// gets a fixed pick). Colour names are DCSS_COLOR_MAP keys.
const GEM_COLOUR: Record<string, string> = {
  smoky: 'lightgrey', glittering: 'yellow', shimmering: 'lightgreen', earthy: 'green',
  mossy: 'brown', azure: 'lightblue', jade: 'lightgreen', 'milky-white': 'white',
  starry: 'lightgrey', shining: 'cyan', ivory: 'white', sanguine: 'red',
  midnight: 'darkgrey', prismatic: 'lightmagenta',
}
export function gemGlyph(word: string): { ch: string; colour: string } {
  return { ch: '♦', colour: GEM_COLOUR[word] ?? 'lightgrey' }
}
