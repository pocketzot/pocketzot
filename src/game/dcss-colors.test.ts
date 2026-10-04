import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { dcssToHtml, escHtml, sliceDcss, uiColor, DCSS_COLOR_MAP, DCSS_UI_COLOR } from './dcss-colors'

describe('palette', () => {
  it('style.css --color-0..15 equal the JS table', () => {
    const css = readFileSync(resolve(__dirname, '../style.css'), 'utf8')
    const vars = [...css.matchAll(/--color-(\d+):\s*(#[0-9a-f]{6})/gi)]
      .map(([, n, hex]) => [Number(n), hex.toLowerCase()] as const)
    expect(vars).toHaveLength(16)
    for (const [n, hex] of vars) expect(hex, `--color-${n}`).toBe(DCSS_UI_COLOR[n])
  })
})

describe('escHtml', () => {
  it('escapes &, <, > in that order so & is not double-encoded', () => {
    expect(escHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
    expect(escHtml('&lt;')).toBe('&amp;lt;')
  })
})

describe('uiColor', () => {
  it('returns palette entry for valid index', () => {
    expect(uiColor(0)).toBe(DCSS_UI_COLOR[0])
    expect(uiColor(7)).toBe(DCSS_UI_COLOR[7])  // lightgrey
    expect(uiColor(15)).toBe(DCSS_UI_COLOR[15])
  })

  it('masks index to 4 bits', () => {
    expect(uiColor(16)).toBe(DCSS_UI_COLOR[0])
    expect(uiColor(23)).toBe(DCSS_UI_COLOR[7])
  })
})

describe('dcssToHtml', () => {
  it('returns escaped plain text unchanged when no tags', () => {
    expect(dcssToHtml('hello world')).toBe('hello world')
    expect(dcssToHtml('a < b')).toBe('a &lt; b')
  })

  it('wraps tagged text in a styled span', () => {
    expect(dcssToHtml('<red>danger</red>'))
      .toBe('<span style="color:#b30009">danger</span>')
  })

  it('closes spans on </tag>', () => {
    const html = dcssToHtml('<red>x</red>y')
    expect(html).toBe('<span style="color:#b30009">x</span>y')
  })

  it('nests colors and restores outer color on close', () => {
    // outer red, inner blue, then back to red
    const html = dcssToHtml('<red>a<blue>b</blue>c</red>')
    expect(html).toBe(
      '<span style="color:#b30009">a</span>' +
      '<span style="color:#005afa">b</span>' +
      '<span style="color:#b30009">c</span>'
    )
  })

  it('treats unpaired close at empty stack as no-op', () => {
    expect(dcssToHtml('</red>plain')).toBe('plain')
  })

  it('closes unterminated spans — prevents nested-span accumulation in msg log', () => {
    // Regression guard. DCSS uses an open-only <color> markup where many
    // server strings omit the closing tag. Without the safeguard at end of
    // dcssToHtml, every such line emits a `<span ...>text` with no close;
    // appending hundreds of those into the message log nests them, growing
    // the DOM unboundedly and tanking render perf. The function MUST emit
    // self-contained, balanced HTML even when the input has an open tag.
    expect(dcssToHtml('<red>unterminated'))
      .toBe('<span style="color:#b30009">unterminated</span>')
  })

  it('separate calls do not leak open spans across boundaries', () => {
    // Companion to the regression test above: each call's output must be
    // independently balanced, so concatenating results (or appending them
    // as sibling nodes) never produces a span that wraps the next call.
    const a = dcssToHtml('<red>a')
    const b = dcssToHtml('<blue>b')
    expect(a).toBe('<span style="color:#b30009">a</span>')
    expect(b).toBe('<span style="color:#005afa">b</span>')
    // Concatenated output has exactly two spans, both closed — no nesting.
    expect((a + b).match(/<span/g)?.length).toBe(2)
    expect((a + b).match(/<\/span>/g)?.length).toBe(2)
  })

  it('drops unknown color tags (keeps text)', () => {
    expect(dcssToHtml('<bogus>x</bogus>')).toBe('x')
  })

  it('renders a raw < inside payload as a literal, not a pseudo-tag', () => {
    // A lone '<' that doesn't form a complete tag is escaped to &lt; and the
    // surrounding markup is preserved (the old /(<[^>]+>)/ splitter swallowed
    // "< b></red>" as one token and truncated the line).
    expect(dcssToHtml('<red>a < b</red>'))
      .toBe('<span style="color:#b30009">a &lt; b</span>')
  })

  it('unescapes the engine\'s doubled << to a literal <', () => {
    // DCSS doubles a literal '<' to '<<' because '<' opens a markup tag.
    expect(dcssToHtml('a << b')).toBe('a &lt; b')
  })

  it('keeps the leading < of the ring-swap prompt (<w><<</w>)', () => {
    // Regression for item-use.cc _item_swap_prompt: the '<' swap slot arrives
    // as `<w><<</w> or a - …`. The greedy splitter ate `<<</w>` as a bogus tag
    // and dropped both the '<' and the close, so the line lost its first char.
    expect(dcssToHtml('<w><<</w> or a - the ring of Iduirph'))
      .toBe('<span style="color:#eeeeec">&lt;</span> or a - the ring of Iduirph')
  })

  it('handles <w> alias as a white highlight', () => {
    expect(dcssToHtml('<w>K</w>'))
      .toBe('<span style="color:#eeeeec">K</span>')
  })
})

describe('sliceDcss', () => {
  // The spell-row shape: one outer tag, a nested fail tag.
  const row = '<lightgrey>Foxfire  <yellow>3%</yellow>  1</lightgrey>'

  it('counts plain columns only and re-opens the tags open at the start', () => {
    expect(sliceDcss(row, 0, 7)).toBe('<lightgrey>Foxfire')
    expect(sliceDcss(row, 9, 11)).toBe('<lightgrey><yellow>3%')
    expect(sliceDcss(row, 13)).toBe('<lightgrey>1</lightgrey>')
  })

  it('renders each slice in the colour it had in place', () => {
    // The re-opened outer tag paints an empty span first; only the inner
    // colour carries text.
    expect(dcssToHtml(sliceDcss(row, 9, 11)).replace(/<span[^>]*><\/span>/g, ''))
      .toBe(dcssToHtml('<yellow>3%</yellow>'))
    expect(dcssToHtml(sliceDcss(row, 13, 14))).toBe(dcssToHtml('<lightgrey>1</lightgrey>'))
    // Text after the inner tag closes is back in the outer colour.
    expect(dcssToHtml(sliceDcss(row, 9))).toContain(`<span style="color:${DCSS_COLOR_MAP.lightgrey}">  1`)
  })

  it('keeps escapes and literals one column each', () => {
    expect(sliceDcss('<w><<</w> or a&b', 0, 1)).toBe('<w><<')
    expect(sliceDcss('a&b>c', 1, 4)).toBe('&b>')
    expect(sliceDcss('<bogus>ab', 1)).toBe('b')
  })
})
