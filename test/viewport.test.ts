import { describe, expect, test } from 'vitest'
import { inferViewport, VIEWPORTS, type Viewport } from '../src/viewport'

describe('inferViewport', () => {
  test('common portrait devices', () => {
    expect(inferViewport(375, 812)).toBe('mobile')
    expect(inferViewport(390, 844)).toBe('mobile')
    expect(inferViewport(768, 1024)).toBe('tablet')
    expect(inferViewport(834, 1194)).toBe('tablet')
  })

  test('landscape devices are not misread as desktop', () => {
    // Old behaviour: every one of these returned 'desktop' or 'tablet'.
    expect(inferViewport(812, 375)).toBe('mobile-ls')
    expect(inferViewport(844, 390)).toBe('mobile-ls')
    expect(inferViewport(1024, 768)).toBe('tablet-ls')
    expect(inferViewport(1194, 834)).toBe('tablet-ls')
  })

  test('watch sizes', () => {
    expect(inferViewport(176, 215)).toBe('watch')
    expect(inferViewport(198, 242)).toBe('watch')
  })

  test('desktop sizes', () => {
    expect(inferViewport(1440, 900)).toBe('desktop')
    expect(inferViewport(1920, 1080)).toBe('desktop')
    expect(inferViewport(1600, 2000)).toBe('desktop')
  })

  test('every declared viewport is reachable', () => {
    const reached = new Set<Viewport>()
    for (let w = 1; w <= 2200; w += 1) {
      for (const h of [1, 120, 200, 375, 400, 800, 900, 1100, 1400, 2000]) {
        reached.add(inferViewport(w, h))
      }
    }
    for (const v of VIEWPORTS) expect(reached).toContain(v)
  })

  test('degenerate dimensions fall back rather than throwing', () => {
    expect(inferViewport(0, 0)).toBe('desktop')
    expect(inferViewport(375, 0)).toBe('mobile')
    expect(inferViewport(Number.NaN, Number.NaN)).toBe('desktop')
    expect(inferViewport(-5, -5)).toBe('desktop')
  })

  test('square frames are treated as portrait', () => {
    expect(inferViewport(800, 800)).toBe('mobile')
  })
})
