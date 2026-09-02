// One-off sweep: run unwrapHangingIndents against wire bodies generated from
// the REAL game strings in the DCSS 0.34.1 reference source, replicating the
// server's formatting pipeline (unwrap_desc → _format_prop_desc /
// _format_dbrand: greedy word-wrap at 80−prefix cols, continuation lines
// padded to the description column). Asserts word-for-word fidelity of every
// joined block. Skipped automatically when the reference checkout is absent.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { unwrapHangingIndents, plainStatSegments, HANG_MARK } from './overlay-body'

const SRC = resolve(__dirname, '../../../crawl-0.34.1/crawl-ref/source')
const hasRef = existsSync(SRC)

// --- server-side replication ---------------------------------------------

// unwrap_desc (libutil.cc:505): join the DB file's wrapped lines; blank lines
// separate paragraphs (kept as \n); indented lines are pre-formatted (kept).
function unwrapDesc(desc: string): string {
  let d = desc.replace(/\s+$/, '')
  if (d === '') return ''
  while (d[0] === ':') {
    const pos = d.indexOf('\n')
    const tag = d.slice(1, pos)
    d = d.slice(pos + 1)
    if (tag === 'nowrap') return d
    if (d === '') return ''
  }
  d = d.replaceAll('\n\n', '\\n\\n')
  d = d.replaceAll('\n ', '\\n ')
  d = d.replaceAll('>\n<', '><')
  d = d.replaceAll('\n', ' ')
  d = d.replaceAll('\\n', '\n')
  return d
}

// linebreak_string (menu.cc:3646) / wordwrap_line (stringutil.cc:173):
// greedy fill, break at last space, existing newlines respected. The game
// strings here carry no <tags>, so the tag-skipping branch is omitted.
function linebreak(s: string, width: number): string {
  const out: string[] = []
  for (const para of s.split('\n')) {
    let rest = para
    while (rest.length > width) {
      let cut = rest.lastIndexOf(' ', width)
      if (cut <= 0) cut = width
      out.push(rest.slice(0, cut))
      rest = rest.slice(cut).replace(/^ +/, '')
    }
    out.push(rest)
  }
  return out.join('\n')
}

// _format_prop_desc (describe.cc:259)
function formatPropDesc(propName: string, propDesc: string): string {
  const nameLen = propName.length
  const broken = linebreak(propDesc, 80 - nameLen)
  return propName + broken.replaceAll('\n', '\n' + ' '.repeat(nameLen))
}

const MAX_ARTP_NAME_LEN = 10

// _format_dbrand (describe.cc:852): split each power on the first ':',
// pad the label to max(11, len+2), trim the description (split_string trims).
function formatDbrand(dbrand: string): string {
  return dbrand.split('\n').map(l => {
    const ci = l.indexOf(':')
    if (ci === -1) return l
    const label = l.slice(0, ci).trim()
    const desc = l.slice(ci + 1).trim()
    if (!desc) return l
    const prefixLen = Math.max(MAX_ARTP_NAME_LEN + 1, label.length + 2)
    const pre = (label + ':').padEnd(prefixLen)
    return formatPropDesc(pre, desc)
  }).join('\n')
}

// --- data file parsing -----------------------------------------------------

function parseEgosTxt(): { key: string; desc: string }[] {
  const raw = readFileSync(resolve(SRC, 'dat/descript/egos.txt'), 'utf8')
  const out: { key: string; desc: string }[] = []
  for (const entry of raw.split('%%%%')) {
    const lines = entry.replace(/^\n+/, '').split('\n')
    const key = lines[0]?.trim()
    const desc = lines.slice(1).join('\n').trim()
    if (key && desc) out.push({ key, desc })
  }
  return out
}

// art-data.txt: DBRAND:/DESCRIP: values; leading-space lines continue the
// previous field joined with ' '; leading '+' lines append with '\n'.
function parseArtData(): { name: string; field: string; value: string }[] {
  const raw = readFileSync(resolve(SRC, 'art-data.txt'), 'utf8')
  const out: { name: string; field: string; value: string }[] = []
  let name = ''
  let prevField = ''
  for (let line of raw.split('\n')) {
    if (/^#/.test(line)) continue
    line = line.replace(/#.*/, '').replace(/\s+$/, '')
    if (!line.trim()) { prevField = ''; continue }
    const cont = /^[\s+]/.test(line)
    if (cont) {
      if (prevField === 'DBRAND' || prevField === 'DESCRIP') {
        const sep = line[0] === '+' ? '\n' : ' '
        const rest = line.replace(/^(\+|\s*)\s*/, '')
        const last = out[out.length - 1]
        last.value += sep + rest
      }
      continue
    }
    const m = line.match(/^([^:]+):\s*(.*)$/)
    if (!m) continue
    prevField = m[1]
    if (m[1] === 'NAME') name = m[2]
    if (m[1] === 'DBRAND' || m[1] === 'DESCRIP') {
      out.push({ name, field: m[1], value: m[2] })
    }
  }
  return out
}

// artprop descriptions (describe.cc:323 table + custom Will/Stealth strings),
// each behind an 11-char padded abbrev label.
function artpBodies(): { label: string; desc: string }[] {
  const plain = [
    'It affects your AC (+5).',
    'It affects your evasion (-3).',
    'It affects your accuracy & damage with ranged weapons and melee (+6).',
    'It insulates you from electricity.',
    'It protects you from poison.',
    'It affects your health (-8).',
    'It affects your magic capacity (+9).',
    'It lets you see invisible.',
    'It lets you turn invisible.',
    'It grants you flight.',
    'It lets you blink.',
    'It may make a loud noise when swung.',
    'It prevents spellcasting.',
    'It prevents most forms of teleportation.',
    'It berserks you when you make melee attacks (5% chance).',
    'It protects you from confusion, rage, mesmerisation and fear.',
    'It causes magical contamination when unequipped.',
    'It protects you from missiles.',
    'It increases your rate of health regeneration.',
    'It protects you from acid and corrosion.',
    'It protects you from mutation.',
    'It may corrode you when you take damage.',
    'It drains your maximum health when unequipped.',
    'It may slow you when you take damage.',
    'It will be destroyed if unequipped.',
    'It greatly increases your willpower.',
    'It makes you much more stealthy.',
  ]
  const symbolicPrefixes = [
    'It makes you extremely vulnerable to ',
    'It makes you very vulnerable to ',
    'It makes you vulnerable to ',
    'It protects you from ',
    'It greatly protects you from ',
    'It renders you almost immune to ',
  ]
  const resists = ['fire', 'cold', 'negative energy']
  const descs = [
    ...plain,
    ...symbolicPrefixes.flatMap(p => resists.map(r => p + r + '.')),
  ]
  const labels = ['AC:', 'rF+:', 'Will+:', 'Rampage:', '*Corrode:', 'SInv:']
  return descs.flatMap((desc, i) => [
    { label: labels[i % labels.length].padEnd(MAX_ARTP_NAME_LEN + 1), desc },
  ])
}

// --- fidelity check --------------------------------------------------------

const words = (s: string) => s.split(/\s+/).filter(Boolean)

interface Case { source: string; label: string; desc: string; wire: string }

function buildCases(): Case[] {
  const cases: Case[] = []
  for (const { key, desc } of parseEgosTxt()) {
    const unwrapped = unwrapDesc(desc).trim()
    if (!unwrapped) continue
    // Armour egos go through _format_prop_desc (describe.cc:2338 mundane
    // `'Of X': ` form, describe.cc:2335 artefact 11-pad form); weapon brands
    // through the same formatter behind `Terse:` padded to 11
    // (describe.cc:1633 "Hack to match artefact prop formatting") — a terse
    // name that fills the column ("Foul flame:") gets NO separating space.
    // Missile ego strings are emitted as plain paragraphs.
    // (`{{ lua }}` templates are evaluated server-side before formatting —
    // not replicated here, so those entries are skipped.)
    const brand = key.match(/^[^(]+\(([^)]+)\) weapon ego$/)
    if (brand && !desc.includes('{{')) {
      const terse = brand[1]
      const label = (terse[0].toUpperCase() + terse.slice(1) + ':').padEnd(MAX_ARTP_NAME_LEN + 1)
      cases.push({ source: `brand:${key}`, label: label.trim(), desc: unwrapped,
        wire: formatPropDesc(label, unwrapped) })
    }
    if (key.endsWith('armour ego')) {
      const name = key.split(' (')[0]
      const label = `'Of ${name}': `
      cases.push({ source: `ego:${key}`, label: label.trim(), desc: unwrapped,
        wire: formatPropDesc(label, unwrapped) })
      cases.push({ source: `ego-pad:${key}`, label: 'Mesmerism:', desc: unwrapped,
        wire: formatPropDesc('Mesmerism:'.padEnd(MAX_ARTP_NAME_LEN + 1), unwrapped) })
    }
  }
  for (const { name, field, value } of parseArtData()) {
    for (const power of value.split('\n')) {
      const ci = power.indexOf(':')
      if (ci === -1) continue
      cases.push({ source: `${field}:${name}`, label: power.slice(0, ci).trim() + ':',
        desc: power.slice(ci + 1).trim(), wire: formatDbrand(power) })
    }
  }
  for (const { label, desc } of artpBodies()) {
    cases.push({ source: `artp:${label.trim()}`, label: label.trim(), desc,
      wire: formatPropDesc(label, desc) })
  }
  return cases
}

describe.skipIf(!hasRef)('unwrapHangingIndents vs the full description corpus', () => {
  // Regression net for the rest of the game's text: every entry in every
  // descript DB file (plus the quotes DB), processed the way the server
  // does (unwrap_desc + 80-col wrap), must produce ZERO marked lines —
  // padded-label rows only ever come from the C++ formatters, so any mark
  // here is a false positive that changed how prose/verse/diagrams render.
  it('marks nothing in raw DB prose, quotes, and pre-formatted blocks', () => {
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    const files = readdirSync(resolve(SRC, 'dat/descript'))
      .filter((f: string) => f.endsWith('.txt'))
      .map((f: string) => `dat/descript/${f}`)
    let entries = 0
    const marked: string[] = []
    for (const file of files) {
      const raw = readFileSync(resolve(SRC, file), 'utf8')
      for (const entry of raw.split('%%%%')) {
        const lines = entry.replace(/^\n+/, '').split('\n')
        const key = lines[0]?.trim()
        const desc = lines.slice(1).join('\n').trim()
        if (!key || !desc) continue
        entries++
        const nowrap = desc.startsWith(':nowrap')
        const unwrapped = unwrapDesc(desc)
        if (!unwrapped) continue
        let wire = nowrap ? unwrapped : linebreak(unwrapped, 80)
        // Quotes are emitted wrapped in a darkgrey colour switch on their
        // first line (describe.cc); plain-text quote fields (msg.quote,
        // feats[].quote) never pass through unwrapHangingIndents at all —
        // it runs before the client appends them.
        if (file.endsWith('quotes.txt')) wire = '<darkgrey>' + wire
        const result = unwrapHangingIndents(wire)
        for (const l of result.split('\n')) {
          if (l.includes(HANG_MARK)) marked.push(`${file} :: ${key} :: ${JSON.stringify(l.replace(HANG_MARK, ''))}`)
          // chip-row detector must not fire on prose either
          if (plainStatSegments(l)) marked.push(`${file} :: ${key} :: CHIPS :: ${JSON.stringify(l)}`)
        }
      }
    }
    writeFileSync('/tmp/hang-corpus-stats.txt',
      `files: ${files.length}\nentries: ${entries}\nmarked: ${marked.length}\n` + marked.join('\n'))
    expect(entries).toBeGreaterThan(1000)
    expect(marked).toEqual([])
  })
})

describe.skipIf(!hasRef)('unwrapHangingIndents vs real DCSS strings', () => {
  it('handles every block word-for-word: multi-line joined, padded single-line collapsed, prose untouched', () => {
    const cases = buildCases()
    expect(cases.length).toBeGreaterThan(100)
    let joined = 0
    let collapsed = 0
    let untouched = 0
    const anomalies: string[] = []
    for (const c of cases) {
      const result = unwrapHangingIndents(c.wire)
      const lines = c.wire.split('\n')
      const isMulti = lines.length > 1
      // single-line rows with ≥2 padding spaces get the collapse+hang too;
      // single-space rows (the mundane `'Of X': ` form) are ordinary prose
      const isPaddedSingle = !isMulti && /^[^\s<][^<]*?: {2}/.test(lines[0])
      if (!isMulti && !isPaddedSingle) {
        untouched++
        if (result !== c.wire) anomalies.push(`${c.source}: prose single-line body changed`)
        continue
      }
      const resultLines = result.split('\n')
      if (!resultLines[0].startsWith(HANG_MARK)) {
        anomalies.push(`${c.source}: block NOT marked:\n${c.wire}`)
        continue
      }
      if (isMulti) joined++
      else collapsed++
      // fidelity: marked text must contain exactly label + desc, word for word
      // (a label that fills its column has no separating space on the wire —
      // "Foul flame:It …" — and is kept verbatim, so it joins the first word)
      const got = words(result.replaceAll(HANG_MARK, ''))
      const want = words(c.label + (c.wire.startsWith(c.label + ' ') ? ' ' : '') + c.desc)
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        anomalies.push(`${c.source}: word mismatch\n got: ${got.join(' ')}\nwant: ${want.join(' ')}`)
      }
      // no residual staircase: nothing left over that still carries the
      // server's continuation padding (would catch partial joins)
      if (resultLines.slice(1).some(l => /^ {4,}/.test(l))) {
        anomalies.push(`${c.source}: residual indented line:\n${result}`)
      }
    }
    const bySource = (p: string) => cases.filter(c => c.source.startsWith(p)).length
    writeFileSync('/tmp/hang-sweep-stats.txt', [
      `cases: ${cases.length} (armour-ego: ${bySource('ego:')}, ego-pad: ${bySource('ego-pad:')}, brand: ${bySource('brand:')}, dbrand/descrip: ${bySource('DBRAND') + bySource('DESCRIP')}, artp: ${bySource('artp:')})`,
      `multi-line joined: ${joined}`,
      `single-line collapsed: ${collapsed}`,
      `untouched prose: ${untouched}`,
      `anomalies: ${anomalies.length}`,
      ...anomalies,
    ].join('\n'))
    expect(anomalies).toEqual([])
  })
})
