/**
 * Drives the built dist/ui.html in jsdom, standing in for the Figma host. This
 * covers the wiring that unit tests cannot reach: name previews across every
 * selected frame, global overrides, focus retention while typing, and surfaced
 * apply failures.
 *
 * Requires `npm run build:ui` first; `npm run check` runs it in the right order.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { JSDOM } from 'jsdom'
import { beforeEach, describe, expect, test } from 'vitest'
import type { FrameInfo } from '../src/code'

const UI_PATH = resolve(__dirname, '../dist/ui.html')

interface Harness {
  window: JSDOM['window']
  sent: Array<Record<string, unknown>>
  toUI: (message: Record<string, unknown>) => void
  q: <T extends HTMLElement>(selector: string) => T
  cards: () => HTMLElement[]
  previews: () => string[]
}

function load(): Harness {
  const html = readFileSync(UI_PATH, 'utf8')
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  if (!script) throw new Error('No inlined script in dist/ui.html — run `npm run build:ui`')

  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true })
  const { window } = dom
  const sent: Array<Record<string, unknown>> = []

  // Hooked before the UI script runs, so the initial 'ready' post is captured.
  ;(window.parent as unknown as { postMessage: (m: unknown) => void }).postMessage = (
    message: unknown,
  ) => {
    sent.push((message as { pluginMessage: Record<string, unknown> }).pluginMessage)
  }
  window.eval(script)

  return {
    window,
    sent,
    toUI: (message) => {
      ;(window as unknown as { onmessage: (e: unknown) => void }).onmessage({
        data: { pluginMessage: message },
      })
    },
    q: <T extends HTMLElement>(selector: string) =>
      window.document.querySelector(selector) as T,
    cards: () => Array.from(window.document.querySelectorAll<HTMLElement>('[data-card]')),
    previews: () =>
      Array.from(window.document.querySelectorAll('[data-card-preview]')).map(
        (el) => el.textContent ?? '',
      ),
  }
}

const frame = (id: string, over: Partial<FrameInfo> = {}): FrameInfo => ({
  id,
  name: `Frame ${id}`,
  width: 375,
  height: 812,
  inferredViewport: 'mobile',
  isLocked: false,
  isComponent: false,
  contentName: 'sign-in',
  contentUnrepresentable: false,
  renamableLayerCount: 4,
  ...over,
})

let h: Harness

beforeEach(() => {
  h = load()
})

const fire = (el: Element, type: string) => {
  el.dispatchEvent(new h.window.Event(type))
}

const setInput = (el: HTMLInputElement | HTMLSelectElement, value: string, type = 'input') => {
  el.value = value
  fire(el, type)
}

/** Selection plus a completed step 1, which is the precondition for step 2. */
const selectAndRename = (frames: FrameInfo[]) => {
  h.toUI({ type: 'selection-change', frames })
  h.toUI({ type: 'layers-renamed', count: frames.length * 4 })
}

describe('startup', () => {
  test('announces readiness to the plugin', () => {
    expect(h.sent).toEqual([{ type: 'ready' }])
  })

  test('shows the empty state with no selection', () => {
    h.toUI({ type: 'init', frames: [] })
    expect(h.q('#empty-state').hidden).toBe(false)
    expect(h.q('#step1').hidden).toBe(true)
  })
})

describe('step 1', () => {
  test('counts layers across the whole selection', () => {
    h.toUI({ type: 'init', frames: [frame('a'), frame('b'), frame('c')] })
    expect(h.q<HTMLButtonElement>('#rename-layers-btn').disabled).toBe(false)
    expect(h.q('#step1-hint').textContent).toBe('12 layers will be renamed')
  })

  test('gates step 2 until step 1 completes', () => {
    h.toUI({ type: 'init', frames: [frame('a')] })
    expect(h.q('#step2').classList.contains('locked')).toBe(true)
    h.toUI({ type: 'layers-renamed', count: 4 })
    expect(h.q('#step2').classList.contains('locked')).toBe(false)
  })

  test('reports when every selected frame is skipped', () => {
    h.toUI({ type: 'init', frames: [frame('a', { isComponent: true })] })
    expect(h.q('#step1-desc').textContent).toContain('components or locked')
    expect(h.q<HTMLButtonElement>('#rename-layers-btn').disabled).toBe(true)
  })
})

describe('step 2 — every frame is processed', () => {
  test('renders a card per frame, not just the first', () => {
    selectAndRename([frame('a'), frame('b'), frame('c')])
    expect(h.cards()).toHaveLength(3)
    // The original returned from inside its loop, leaving 2 and 3 unnamed.
    expect(h.previews().every((p) => p.startsWith('Needs feature'))).toBe(true)
  })

  test('names every frame once a feature is supplied', () => {
    selectAndRename([frame('a'), frame('b'), frame('c')])
    setInput(h.q<HTMLInputElement>('#global-feature'), 'checkout')
    const names = h.previews()
    expect(names).toHaveLength(3)
    expect(names.every((n) => n.startsWith('checkout_mobile_sign-in'))).toBe(true)
    expect(new Set(names).size).toBe(3)
  })
})

describe('global overrides', () => {
  beforeEach(() => {
    selectAndRename([frame('a'), frame('b')])
  })

  test('clearing the global feature restores per-frame values', () => {
    const global = h.q<HTMLInputElement>('#global-feature')
    setInput(global, 'checkout')
    expect(h.previews()[0]).toContain('checkout_')
    setInput(global, '')
    expect(h.previews().every((p) => p.startsWith('Needs feature'))).toBe(true)
  })

  test('"keep per-frame" viewport is not a no-op', () => {
    setInput(h.q<HTMLInputElement>('#global-feature'), 'checkout')
    const viewport = h.q<HTMLSelectElement>('#global-viewport')
    setInput(viewport, 'desktop', 'change')
    expect(h.previews()[0]).toContain('_desktop_')
    setInput(viewport, '', 'change')
    expect(h.previews()[0]).toContain('_mobile_')
  })
})

describe('typing', () => {
  test('does not destroy the focused field', () => {
    selectAndRename([frame('a'), frame('b')])
    const input = h.cards()[0].querySelector<HTMLInputElement>('[data-input="feature"]')!
    input.focus()
    setInput(input, 'cart')
    expect(h.window.document.activeElement).toBe(input)
    expect(input.value).toBe('cart')
    expect(h.previews()[0]).toBe('cart_mobile_sign-in')
  })

  test('per-frame input survives a selection change', () => {
    selectAndRename([frame('a'), frame('b')])
    const input = h.cards()[0].querySelector<HTMLInputElement>('[data-input="feature"]')!
    setInput(input, 'cart')

    selectAndRename([frame('a'), frame('b')])
    const after = h.cards()[0].querySelector<HTMLInputElement>('[data-input="feature"]')!
    expect(after.value).toBe('cart')
  })

  test('deselected frames are dropped from the list', () => {
    selectAndRename([frame('a'), frame('b'), frame('c')])
    expect(h.cards()).toHaveLength(3)
    selectAndRename([frame('a')])
    expect(h.cards()).toHaveLength(1)
  })
})

describe('apply', () => {
  test('sends a unique name for every actionable frame', () => {
    selectAndRename([frame('a'), frame('b')])
    setInput(h.q<HTMLInputElement>('#global-feature'), 'cart')
    expect(h.q<HTMLButtonElement>('#apply-btn').disabled).toBe(false)

    fire(h.q('#apply-btn'), 'click')
    const apply = h.sent.filter((m) => m.type === 'apply').pop() as {
      renames: Array<{ id: string; newName: string }>
    }
    expect(apply.renames).toHaveLength(2)
    expect(new Set(apply.renames.map((r) => r.newName)).size).toBe(2)
  })

  test('stays disabled while any frame is incomplete', () => {
    selectAndRename([frame('a'), frame('b')])
    const input = h.cards()[0].querySelector<HTMLInputElement>('[data-input="feature"]')!
    setInput(input, 'cart')
    expect(h.q<HTMLButtonElement>('#apply-btn').disabled).toBe(true)
  })

  test('surfaces per-frame failures instead of swallowing them', () => {
    selectAndRename([frame('a'), frame('b')])
    h.toUI({
      type: 'apply-done',
      count: 1,
      failures: [{ id: 'b', reason: 'Frame no longer exists' }],
    })
    expect(h.q('#failures').hidden).toBe(false)
    expect(h.q('#failures-title').textContent).toBe('1 frame skipped')
    expect(h.q('#failures-list').textContent).toContain('no longer exists')
  })
})

describe('skipped and unnameable frames', () => {
  test('components are marked and excluded from the count', () => {
    selectAndRename([frame('c1', { isComponent: true }), frame('n1')])
    expect(h.cards()[0].classList.contains('skipped')).toBe(true)
    expect(h.q('#frames-summary').textContent).toBe('1 frame to rename')
  })

  test('unrepresentable text asks for a manual name rather than guessing', () => {
    selectAndRename([frame('z', { contentName: '', contentUnrepresentable: true })])
    expect(h.previews()[0]).toContain('cannot be auto-named')
  })
})

describe('height reporting', () => {
  test('reports a height to the host', () => {
    h.toUI({ type: 'init', frames: [frame('a')] })
    expect(h.sent.some((m) => m.type === 'resize')).toBe(true)
  })
})

describe('version', () => {
  test('shows the version the plugin reports at init', () => {
    h.toUI({ type: 'init', frames: [frame('a')], version: '1.2.3' })
    expect(h.q('#version').hidden).toBe(false)
    expect(h.q('#version').textContent).toBe('v1.2.3')
  })

  test('stays hidden until the plugin reports one', () => {
    h.toUI({ type: 'selection-change', frames: [frame('a')] })
    expect(h.q('#version').hidden).toBe(true)
  })
})
