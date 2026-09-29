// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VersionAdvisory } from './version-advisory'

function setup(spectating = false) {
  const view = document.createElement('div')
  const overlay = document.createElement('div')
  const titles: string[] = []
  const leave = vi.fn()
  const advisory = new VersionAdvisory({
    view, overlay, leave, spectating,
    renderOverlay: (title, build) => { titles.push(title); build() },
  })
  const banner = () => view.querySelector('.version-notice')
  return { advisory, view, overlay, titles, leave, banner }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('VersionAdvisory', () => {
  it('stays silent for supported and unparseable versions', () => {
    const { advisory, banner } = setup()
    advisory.check('dcss-0.34', undefined)
    advisory.check('dcss-git')
    expect(banner()).toBeNull()
    vi.runAllTimers()
    expect(banner()).toBeNull()
  })

  it('shows one banner per game below the cutoff', () => {
    const { advisory, view } = setup()
    advisory.check('dcss-0.23')
    advisory.check('dcss-0.22')
    expect(view.querySelectorAll('.version-notice')).toHaveLength(1)
    expect(view.textContent).toContain('0.23')
  })

  it('the banner dismisses on tap and on its own after 15 s', () => {
    const tapped = setup()
    tapped.advisory.check('dcss-0.23')
    ;(tapped.banner() as HTMLElement).click()
    expect(tapped.banner()).toBeNull()

    const waited = setup(true)  // spectating: no guard dialog to remove it first
    waited.advisory.check('dcss-0.23')
    vi.advanceTimersByTime(14999)
    expect(waited.banner()).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(waited.banner()).toBeNull()
  })

  it('offers the way back when nothing renders in time', () => {
    const { advisory, overlay, titles, leave, banner } = setup()
    advisory.check('dcss-0.23')
    vi.advanceTimersByTime(6000)
    expect(titles).toEqual(['Unsupported version'])
    expect(banner()).toBeNull()
    overlay.querySelector<HTMLButtonElement>('.dialog-buttons .button')!.click()
    expect(leave).toHaveBeenCalledOnce()
  })

  it('rendered content disarms the guard', () => {
    const { advisory, titles } = setup()
    advisory.check('dcss-0.23')
    advisory.disarm()
    vi.runAllTimers()
    expect(titles).toEqual([])
  })

  it('a map seen before a late notice keeps the guard quiet', () => {
    const { advisory, titles, banner } = setup()
    advisory.onMap()
    advisory.check('dcss-0.23')
    expect(banner()).not.toBeNull()
    vi.advanceTimersByTime(6000)
    expect(titles).toEqual([])
  })

  it('never arms the guard while spectating', () => {
    const { advisory, titles, banner } = setup(true)
    advisory.check('dcss-0.23')
    expect(banner()).not.toBeNull()
    vi.advanceTimersByTime(6000)
    expect(titles).toEqual([])
  })
})
