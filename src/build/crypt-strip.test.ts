// The build-time crypt strip bake: the PNG codec and the strip layout.
// The real pack is gitignored, so these run on synthetic sheets.
import { describe, expect, it } from 'vitest'
import { composeStrip, decodePng, encodePng, evalTileinfo } from './crypt-strip.js'

function image(width: number, height: number, px: (x: number, y: number) => [number, number, number, number]) {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(px(x, y), (y * width + x) * 4)
  }
  return { width, height, data }
}

const pixel = (img: { width: number; data: Uint8Array }, x: number, y: number) =>
  [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)]

// A tileinfo module the way the pack's generator writes them.
const tileinfo = (body: string, deps = '') =>
  `define([${deps}], function(m) {\nvar exports = {};\n${body}\nreturn exports;\n});`

describe('PNG codec', () => {
  it('round-trips RGBA through every filter type', () => {
    // Gradients favour Sub/Up/Average/Paeth; the noise rows favour None.
    let seed = 7
    const noise = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24
    const img = image(37, 9, (x, y) => y % 3 === 2
      ? [noise(), noise(), noise(), noise()]
      : [x * 6, y * 20, (x * y) & 255, 255 - x])
    const back = decodePng(encodePng(img))
    expect(back.width).toBe(37)
    expect(back.height).toBe(9)
    expect(back.data).toEqual(img.data)
  })

  it('refuses a PNG that is not 8-bit RGBA', () => {
    const png = encodePng(image(2, 2, () => [0, 0, 0, 255]))
    png[25] = 2 // IHDR colour type → RGB
    expect(() => decodePng(png)).toThrow(/RGBA/)
  })
})

describe('evalTileinfo', () => {
  it('hands the module its dependency, as AMD would', () => {
    const floor = evalTileinfo(tileinfo('exports.TILE_FLOOR_MAX = 10;'))
    const wall = evalTileinfo(tileinfo('exports.WALL_X = m.TILE_FLOOR_MAX + 2;', '"./tileinfo-floor"'), floor)
    expect(wall.WALL_X).toBe(12)
  })
})

describe('composeStrip', () => {
  // An 8×4 sheet: red on the left half, green on the right.
  const img = image(8, 4, (x) => (x < 4 ? [255, 0, 0, 255] : [0, 255, 0, 255]))
  const floor = { img, mod: { FLOOR_A: 0, get_tile_info: () => ({ w: 32, h: 32, ox: 0, oy: 0, sx: 0, sy: 0, ex: 4, ey: 4 }) } }
  const feat = { img, mod: { STATUE: 5, get_tile_info: (id: number) => (id === 5 ? { w: 32, h: 32, ox: 10, oy: 20, sx: 4, sy: 0, ex: 8, ey: 4 } : undefined) } }

  it('puts tile i at x = 32i, at its tileinfo offset, transparent elsewhere', () => {
    const strip = composeStrip([floor, feat], ['FLOOR_A', 'STATUE'])
    expect(strip.width).toBe(64)
    expect(strip.height).toBe(32)
    expect(pixel(strip, 0, 0)).toEqual([255, 0, 0, 255])
    expect(pixel(strip, 4, 0)).toEqual([0, 0, 0, 0])
    expect(pixel(strip, 32 + 10, 20)).toEqual([0, 255, 0, 255])
    expect(pixel(strip, 32 + 13, 23)).toEqual([0, 255, 0, 255])
    expect(pixel(strip, 32 + 9, 20)).toEqual([0, 0, 0, 0])
  })

  it('throws on a tile the pack lacks — no room rather than a hole', () => {
    expect(() => composeStrip([floor, feat], ['FLOOR_A', 'NOPE'])).toThrow(/NOPE/)
  })

  it('throws on a sprite that spills out of its cell', () => {
    const big = { img, mod: { BIG: 0, get_tile_info: () => ({ w: 32, h: 32, ox: 30, oy: 0, sx: 0, sy: 0, ex: 4, ey: 4 }) } }
    expect(() => composeStrip([big], ['BIG'])).toThrow(/overflows/)
  })
})
