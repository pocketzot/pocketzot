// The crypt room's layout: the floor's seams, its prefix stability (growing
// the floor never re-lays rows already shown), and the frieze's composition.
import { describe, expect, it } from 'vitest'
import { floorEdges, friezeRow, layFloor, roomCols, STRIP } from './crypt-room-layout'

describe('layFloor', () => {
  for (const [cols, seed] of [[7, 1], [15, 1], [23, 7], [9, 12345]] as const) {
    it(`matches every shared edge (${cols} cols, seed ${seed})`, () => {
      const rows = 40
      const f = layFloor(cols, rows, seed)
      expect(f).toHaveLength(cols * rows)
      const e = (x: number, y: number) => floorEdges(f[y * cols + x]!)!
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          expect(e(x, y)).not.toBeNull()
          if (x > 0) expect(e(x, y)[3]).toBe(e(x - 1, y)[1])
          if (y > 0) expect(e(x, y)[0]).toBe(e(x, y - 1)[2])
        }
      }
    })
  }

  it('grows by adding rows, never re-laying the ones above', () => {
    const short = layFloor(15, 8, 1)
    const tall = layFloor(15, 32, 1)
    expect(tall.slice(0, short.length)).toEqual(short)
  })

  it('is the same room every time', () => {
    expect(layFloor(15, 16, 1)).toEqual(layFloor(15, 16, 1))
  })

  it('uses all eight tiles and the rare alternates', () => {
    const used = new Set(layFloor(15, 64, 1))
    for (const n of ['FLOOR_CRYPT', 'FLOOR_CRYPT_B', 'FLOOR_CRYPT_C', 'FLOOR_CRYPT_D', 'FLOOR_CRYPT_E',
      'FLOOR_CRYPT_F', 'FLOOR_CRYPT_G', 'FLOOR_CRYPT_H', 'FLOOR_CRYPT_1', 'FLOOR_CRYPT_D_1']) {
      expect(used).toContain(n)
    }
  })
})

describe('friezeRow', () => {
  it('follows the fate in the centre seven', () => {
    const centre = (fate: 'won' | 'dead' | null) => friezeRow(fate, 7, 1).map((c) => c.obj ?? c.wall)
    expect(centre('won')).toEqual(['WALL_CRYPT_2', 'DNGN_GOLDEN_STATUE', 'WALL_CRYPT_3', 'DNGN_EXIT_DUNGEON',
      'WALL_CRYPT_3', 'DNGN_GOLDEN_STATUE_1', 'WALL_CRYPT_1'])
    expect(centre('dead')).toEqual(['WALL_CRYPT_4', 'WALL_CRYPT_9', 'WALL_CRYPT_1', 'DNGN_STATUE_WRAITH',
      'WALL_CRYPT_2', 'WALL_CRYPT_7', 'WALL_CRYPT_4'])
    expect(centre(null)).toEqual(['WALL_CRYPT', 'WALL_CRYPT_3', 'WALL_CRYPT_6', 'WALL_CRYPT_8',
      'WALL_CRYPT_5', 'WALL_CRYPT_3', 'WALL_CRYPT_1'])
  })

  it('centres the design and flanks it with plain-run walls on wide screens', () => {
    const row = friezeRow('dead', 23, 1)
    expect(row).toHaveLength(23)
    expect(row[11]!.obj).toBe('DNGN_STATUE_WRAITH')
    const flanks = [...row.slice(0, 8), ...row.slice(15)]
    for (const c of flanks) {
      expect(c.obj).toBeUndefined()
      expect(['WALL_CRYPT', 'WALL_CRYPT_1', 'WALL_CRYPT_2', 'WALL_CRYPT_4']).toContain(c.wall)
    }
  })

  it('draws only tiles in the strip', () => {
    for (const fate of ['won', 'dead', null] as const) {
      for (const c of friezeRow(fate, 31, 1)) {
        expect(STRIP).toContain(c.wall)
        if (c.obj) expect(STRIP).toContain(c.obj)
      }
    }
    for (const n of layFloor(15, 32, 1)) expect(STRIP).toContain(n)
  })
})

describe('roomCols', () => {
  it('is odd, covers the span, and never narrower than the design', () => {
    expect(roomCols(402)).toBe(7)
    expect(roomCols(874)).toBe(15)
    expect(roomCols(1366)).toBe(23)
    expect(roomCols(1024)).toBe(17)
  })
})
