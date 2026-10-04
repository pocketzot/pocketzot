// Build-time only (Node): bakes the crypt room's tile strip (crypt-room.ts)
// from the offline pack in public/gamedata/local/, so the room ships to
// every player, pack or not. The one caller is vite.config.ts's cryptStrip
// plugin; the app never imports this file. Plain JS, like src/sw/classify.js:
// tsc (DOM types only) never sees the node: imports.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// zlib.crc32: Node 22.2+.
import { crc32, deflateSync, inflateSync } from 'node:zlib'

// tile-view.ts CELL: the art's native tile size.
const CELL = 32

// The sheets the room's tiles come from, in lookup order. Each tileinfo
// module takes the previous one as its AMD dependency: its ids continue
// where that sheet's end (get_tile_info subtracts m.TILE_<prev>_MAX).
const SHEETS = ['floor', 'wall', 'feat']

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// The strip for `names` as PNG bytes: tile i at x = i * CELL. Throws when
// the pack is absent or lacks a tile — no room, rather than one with a hole.
export function bakeCryptStrip(dir, names) {
  const sheets = []
  let prev
  for (const name of SHEETS) {
    const mod = evalTileinfo(readFileSync(join(dir, `tileinfo-${name}.js`), 'utf8'), prev)
    sheets.push({ mod, img: decodePng(readFileSync(join(dir, `${name}.png`))) })
    prev = mod
  }
  return encodePng(composeStrip(sheets, names))
}

// Runs a generated tileinfo module (`define([dep], function (m) {…})`),
// handing it `dep` as m.
export function evalTileinfo(src, dep) {
  let mod
  new Function('define', src)((_deps, factory) => { mod = factory(dep) })
  if (!mod) throw new Error('tileinfo module defined nothing')
  return mod
}

// sheets: [{ mod, img: { width, height, data } }]. Each tile lands at its
// tileinfo offset, as spritePlacement(s, 0, 0) places it at runtime.
export function composeStrip(sheets, names) {
  const width = names.length * CELL
  const data = new Uint8Array(width * CELL * 4)
  names.forEach((name, i) => {
    const sheet = sheets.find((s) => typeof s.mod[name] === 'number')
    if (!sheet) throw new Error(`the pack has no ${name}`)
    const t = sheet.mod.get_tile_info(sheet.mod[name])
    const w = t.ex - t.sx
    const h = t.ey - t.sy
    // A plain copy is exact only while each sprite stays inside its own
    // transparent cell; one that spills would need compositing.
    if (t.ox < 0 || t.oy < 0 || t.ox + w > CELL || t.oy + h > CELL) {
      throw new Error(`${name} overflows its ${CELL}px cell`)
    }
    for (let y = 0; y < h; y++) {
      const src = ((t.sy + y) * sheet.img.width + t.sx) * 4
      data.set(sheet.img.data.subarray(src, src + w * 4), ((t.oy + y) * width + i * CELL + t.ox) * 4)
    }
  })
  return { width, height: CELL, data }
}

// 8-bit RGBA, non-interlaced only: the format the pack's atlases are in.
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG')
  let width = 0
  let height = 0
  const idat = []
  for (let p = 8; p < buf.length; ) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('latin1', p + 4, p + 8)
    const body = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) {
        throw new Error('PNG is not 8-bit RGBA, non-interlaced')
      }
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
    p += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const data = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = y * (stride + 1) + 1
    const row = y * stride
    for (let x = 0; x < stride; x++) {
      data[row + x] = (raw[line + x] + predict(filter, data, row, stride, x, y)) & 255
    }
  }
  return { width, height, data }
}

export function encodePng({ width, height, data }) {
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  const trial = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const row = y * stride
    // Per row, the filter with the smallest sum of signed residuals
    // (libpng's heuristic).
    let best = 0
    let bestCost = Infinity
    for (let f = 0; f < 5; f++) {
      let cost = 0
      for (let x = 0; x < stride; x++) {
        const v = (data[row + x] - predict(f, data, row, stride, x, y)) & 255
        cost += v < 128 ? v : 256 - v
      }
      if (cost < bestCost) { best = f; bestCost = cost }
    }
    for (let x = 0; x < stride; x++) trial[x] = data[row + x] - predict(best, data, row, stride, x, y)
    raw[y * (stride + 1)] = best
    raw.set(trial, y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// The PNG filter predictor for byte x of row y, from the unfiltered image.
function predict(filter, data, row, stride, x, y) {
  const a = x >= 4 ? data[row + x - 4] : 0
  const b = y ? data[row - stride + x] : 0
  switch (filter) {
    case 0: return 0
    case 1: return a
    case 2: return b
    case 3: return (a + b) >> 1
    case 4: {
      const c = x >= 4 && y ? data[row - stride + x - 4] : 0
      const p = a + b - c
      const pa = Math.abs(p - a)
      const pb = Math.abs(p - b)
      const pc = Math.abs(p - c)
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
    }
    default: throw new Error(`bad PNG filter ${filter}`)
  }
}

function chunk(type, body) {
  const out = Buffer.alloc(12 + body.length)
  out.writeUInt32BE(body.length, 0)
  out.write(type, 4, 'latin1')
  body.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length)
  return out
}
