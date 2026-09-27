/**
 * Drives the built dist/ui.html in jsdom, standing in for the Figma host. This
 * covers the wiring that unit tests cannot reach: name previews across every
 * selected frame, global overrides, focus retention while typing, and surfaced
 * apply failures.
 *
 * Requires a build first; `npm test` runs one via its pretest hook.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { JSDOM } from 'jsdom'
import { beforeEach, describe, expect, test } from 'vitest'
import type { FrameInfo } from '../src/code'
import { composeFrameName } from '../src/naming'

const UI_PATH = resolve(__dirname, '../dist/ui.html')
const SRC_DIR = resolve(__dirname, '../src')

/**
 * Running vitest directly skips the pretest build, which would silently test a
 * stale bundle and report failures that the current source has already fixed.
 */
function assertBuildIsCurrent(): void {
  const built = statSync(UI_PATH).mtimeMs
  const newest = (dir: string): number => {
    let latest = 0
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name)
      latest = Math.max(latest, entry.isDirectory() ? newest(path) : statSync(path).mtimeMs)
    }
    return latest
  }
  if (newest(SRC_DIR) > built) {
    throw new Error('dist/ui.html is older than src/ — run `npm run build` (or use `npm test`)')
  }
}

interface Harness {
  window: JSDOM['window']
  sent: Array<Record<string, unknown>>
  toUI: (message: Record<string, unknown>) => void
  q: <T extends HTMLElement>(selector: string) => T
  cards: () => HTMLElement[]
  previews: () => string[]
}

function load(): Harness {
  assertBuildIsCurrent()
  const html = readFileSync(UI_PATH, 'utf8')
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  if (!script) throw new Error('No inlined script in dist/ui.html — run `npm run build`')

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
    expect(h.q('#step2').hidden).toBe(true)
  })

  test('the empty state explains what the plugin does', () => {
    h.toUI({ type: 'init', frames: [] })
    const empty = h.q('#empty-state')

    // Not just an instruction: it names the outcome, both steps, and the
    // resulting format, so the panel is legible before anything is selected.
    expect(empty.querySelector('.empty-title')!.textContent).toBeTruthy()
    expect(empty.querySelectorAll('.empty-steps li')).toHaveLength(2)
    expect(empty.textContent).toContain('one user flow')
    expect(empty.textContent).toContain('feature_viewport_flow')
  })

  test('the empty example matches the real name format', () => {
    h.toUI({ type: 'init', frames: [] })
    const after = h.q('#empty-state').querySelector('.empty-after')!.textContent!
    // Must be a name composeFrameName could actually produce.
    expect(after).toBe(
      composeFrameName({ feature: 'checkout', viewport: 'mobile', flow: 'guest checkout' }),
    )
  })

  test('the empty state gives way to the steps once frames are selected', () => {
    h.toUI({ type: 'init', frames: [] })
    expect(h.q('#empty-state').hidden).toBe(false)

    h.toUI({ type: 'selection-change', frames: [frame('a')] })
    expect(h.q('#empty-state').hidden).toBe(true)
    expect(h.q('#step1').hidden).toBe(false)
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

  test('explains the naming rules, collapsed by default', () => {
    h.toUI({ type: 'init', frames: [frame('a')] })
    const explainer = h.q<HTMLDetailsElement>('#step1-explainer')

    expect(explainer.hidden).toBe(false)
    expect(explainer.open).toBe(false)
    expect(explainer.querySelector('summary')!.textContent).toBe('How layers are named')
    // One rule per branch of classify(): text, image, name, container, type.
    expect(explainer.querySelectorAll('.rules li')).toHaveLength(5)
    expect(explainer.textContent).toContain('three levels deep')
  })

  test('hides the explainer when every selected frame is skipped', () => {
    // With no selection at all the whole step is hidden, so the case that
    // matters is a selection the plugin cannot act on.
    h.toUI({ type: 'init', frames: [frame('c', { isComponent: true })] })
    expect(h.q('#step1').hidden).toBe(false)
    expect(h.q<HTMLDetailsElement>('#step1-explainer').hidden).toBe(true)
  })

  test('collapses the explainer once the step is done', () => {
    h.toUI({ type: 'init', frames: [frame('a')] })
    const explainer = h.q<HTMLDetailsElement>('#step1-explainer')
    explainer.open = true

    h.toUI({ type: 'layers-renamed', count: 4 })
    expect(explainer.open).toBe(false)
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

  test('editing one frame leaves the global applying to the others', () => {
    setInput(h.q<HTMLInputElement>('#global-feature'), 'checkout')
    const first = h.cards()[0].querySelector<HTMLInputElement>('[data-input="feature"]')!
    setInput(first, 'cart')

    // The global still applies to every frame the user has not touched, so it
    // stays displayed — only the edited frame opts out.
    expect(h.q<HTMLInputElement>('#global-feature').value).toBe('checkout')
    expect(h.previews()[0]).toBe('cart_mobile_sign-in')
    expect(h.previews()[1]).toBe('checkout_mobile_sign-in')
  })

  test('a per-frame override survives later changes to the global', () => {
    setInput(h.q<HTMLInputElement>('#global-feature'), 'checkout')
    const firstVp = h.cards()[0].querySelector<HTMLSelectElement>('[data-input="viewport"]')!
    setInput(firstVp, 'watch', 'change')

    setInput(h.q<HTMLSelectElement>('#global-viewport'), 'desktop', 'change')
    expect(h.previews()[0]).toContain('_watch_')
    expect(h.previews()[1]).toContain('_desktop_')
  })

  test('"per frame" viewport is not a no-op', () => {
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
    expect(h.q('#frames-summary').textContent).toBe('0 of 1 frame ready')
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

describe('collapsed cards', () => {
  test('cards start collapsed so a long selection stays scannable', () => {
    selectAndRename([frame('a'), frame('b'), frame('c')])
    const fields = h.cards().map((c) => c.querySelector<HTMLElement>('[data-card-fields]')!)
    expect(fields.every((f) => f.hidden)).toBe(true)
  })

  test('the header shows the resulting name without opening the card', () => {
    selectAndRename([frame('a')])
    setInput(h.q<HTMLInputElement>('#global-feature'), 'checkout')
    expect(h.previews()[0]).toBe('checkout_mobile_sign-in')
    expect(h.cards()[0].querySelector('[data-card-fields]')!.hasAttribute('hidden')).toBe(true)
  })

  test('clicking a card header opens just that card', () => {
    selectAndRename([frame('a'), frame('b')])
    fire(h.cards()[0].querySelector('[data-card-toggle]')!, 'click')

    const hidden = h.cards().map((c) => c.querySelector<HTMLElement>('[data-card-fields]')!.hidden)
    expect(hidden).toEqual([false, true])
  })

  test('expand-all and collapse-all switch every card at once', () => {
    selectAndRename([frame('a'), frame('b'), frame('c')])
    const toggle = h.q<HTMLButtonElement>('#expand-toggle')
    const hidden = () =>
      h.cards().map((c) => c.querySelector<HTMLElement>('[data-card-fields]')!.hidden)

    expect(toggle.textContent).toBe('Edit individually')
    fire(toggle, 'click')
    expect(hidden()).toEqual([false, false, false])
    expect(toggle.textContent).toBe('Collapse all')
    fire(toggle, 'click')
    expect(hidden()).toEqual([true, true, true])
  })

  test('a skipped frame has nothing to open', () => {
    selectAndRename([frame('c1', { isComponent: true })])
    const toggle = h.cards()[0].querySelector<HTMLButtonElement>('[data-card-toggle]')!
    expect(toggle.disabled).toBe(true)
  })
})

describe('global flow', () => {
  test('names a whole user flow from two fields', () => {
    // The intended workflow: select the frames of one flow, type feature and
    // flow once, rename — no per-frame editing at all.
    const frames = Array.from({ length: 8 }, (_, i) => frame(`f${i}`, { contentName: '' }))
    selectAndRename(frames)

    setInput(h.q<HTMLInputElement>('#global-feature'), 'checkout')
    setInput(h.q<HTMLInputElement>('#global-flow'), 'guest checkout')

    expect(h.q<HTMLButtonElement>('#apply-btn').disabled).toBe(false)
    expect(h.previews()[0]).toBe('checkout_mobile_guest-checkout')
    expect(h.q('#frames-summary').textContent).toBe('8 of 8 frames ready')
  })

  test('clearing the global flow hands frames back their own', () => {
    selectAndRename([frame('a'), frame('b')])
    setInput(h.q<HTMLInputElement>('#global-feature'), 'checkout')
    const flow = h.q<HTMLInputElement>('#global-flow')

    setInput(flow, 'guest')
    expect(h.previews()[0]).toContain('_guest')
    setInput(flow, '')
    // frame() supplies contentName 'sign-in' as the inferred flow.
    expect(h.previews()[0]).toContain('_sign-in')
  })
})

describe('viewport globals do not destroy inferred values', () => {
  const mixed = () => [
    frame('a', { inferredViewport: 'mobile' }),
    frame('b', { inferredViewport: 'desktop' }),
    frame('c', { inferredViewport: 'tablet' }),
  ]
  const viewports = () =>
    h.cards().map((c) => c.querySelector<HTMLSelectElement>('[data-input="viewport"]')!.value)

  test('applying then releasing a global restores each frame', () => {
    selectAndRename(mixed())
    expect(viewports()).toEqual(['mobile', 'desktop', 'tablet'])

    const global = h.q<HTMLSelectElement>('#global-viewport')
    setInput(global, 'watch', 'change')
    expect(viewports()).toEqual(['watch', 'watch', 'watch'])

    setInput(global, '', 'change')
    expect(viewports()).toEqual(['mobile', 'desktop', 'tablet'])
  })

  test('editing one frame under a global does not freeze the rest', () => {
    // Previously the global's value was committed into every frame on the first
    // per-frame edit, so releasing it left them all reading "watch".
    selectAndRename(mixed())
    setInput(h.q<HTMLSelectElement>('#global-viewport'), 'watch', 'change')

    const first = h.cards()[0].querySelector<HTMLSelectElement>('[data-input="viewport"]')!
    setInput(first, 'mobile', 'change')

    setInput(h.q<HTMLSelectElement>('#global-viewport'), '', 'change')
    expect(viewports()).toEqual(['mobile', 'desktop', 'tablet'])
  })
})

describe('state pruning', () => {
  test('typed input survives one selection change without the frame', () => {
    selectAndRename([frame('a'), frame('b')])
    const input = h.cards()[0].querySelector<HTMLInputElement>('[data-input="feature"]')!
    setInput(input, 'cart')

    // A stray click elsewhere, then back — the typed value is still there.
    selectAndRename([frame('z')])
    selectAndRename([frame('a')])
    expect(
      h.cards()[0].querySelector<HTMLInputElement>('[data-input="feature"]')!.value,
    ).toBe('cart')
  })

  test('is dropped after two selection changes, falling back to inferred values', () => {
    selectAndRename([frame('a')])
    setInput(h.cards()[0].querySelector<HTMLInputElement>('[data-input="feature"]')!, 'cart')

    selectAndRename([frame('z')])
    selectAndRename([frame('z')])
    selectAndRename([frame('a')])

    expect(
      h.cards()[0].querySelector<HTMLInputElement>('[data-input="feature"]')!.value,
    ).toBe('')
  })
})

describe('backend errors', () => {
  test('are surfaced and leave step 1 usable', () => {
    h.toUI({ type: 'init', frames: [frame('a')] })
    fire(h.q('#rename-layers-btn'), 'click')
    expect(h.q<HTMLButtonElement>('#rename-layers-btn').disabled).toBe(true)

    h.toUI({ type: 'error', action: 'rename-layers', reason: 'Node not found' })

    expect(h.q('#failures').hidden).toBe(false)
    expect(h.q('#failures-list').textContent).toContain('Node not found')
    // The button was disabled optimistically; an error must not wedge it.
    expect(h.q<HTMLButtonElement>('#rename-layers-btn').disabled).toBe(false)
  })

  test('clear when the action is retried', () => {
    h.toUI({ type: 'init', frames: [frame('a')] })
    h.toUI({ type: 'error', reason: 'Node not found' })
    expect(h.q('#failures').hidden).toBe(false)

    fire(h.q('#rename-layers-btn'), 'click')
    h.toUI({ type: 'layers-renamed', count: 4 })
    expect(h.q('#failures').hidden).toBe(true)
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
