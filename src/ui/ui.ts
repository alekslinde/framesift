import { composeFrameName, resolveCollisions, toKebab } from '../naming'
import { VIEWPORT_LABELS, VIEWPORTS, type Viewport } from '../viewport'
import type { FrameInfo } from '../code'

interface FrameState {
  feature: string
  viewport: string
  flow: string
}

interface PluginMessage {
  type: 'init' | 'selection-change' | 'layers-renamed' | 'apply-done'
  frames?: FrameInfo[]
  count?: number
  failures?: Array<{ id: string; reason: string }>
  version?: string
}

const state = {
  frames: [] as FrameInfo[],
  layersRenamed: false,
  step1Open: true,
  step2Open: false,
  lastApply: null as { count: number; failures: Array<{ id: string; reason: string }> } | null,
}

/**
 * Per-frame input, keyed by node id and persisted across selection changes so a
 * stray canvas click cannot discard what the user typed. Entries are pruned
 * only when a frame has been absent from the selection for a full cycle.
 */
const frameState = new Map<string, FrameState>()

/** Global overrides. `null` means "not set" — distinct from an empty string. */
const globals: { feature: string | null; viewport: string | null } = {
  feature: null,
  viewport: null,
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Missing element #${id}`)
  return el as T
}

const els = {
  root: $('root'),
  empty: $('empty-state'),
  step1: $('step1'),
  step1Header: $('step1-header'),
  step1Desc: $('step1-desc'),
  step1Hint: $('step1-hint'),
  renameBtn: $<HTMLButtonElement>('rename-layers-btn'),
  badge1: $('badge1'),
  step2: $('step2'),
  step2Header: $('step2-header'),
  badge2: $('badge2'),
  globalFeature: $<HTMLInputElement>('global-feature'),
  globalViewport: $<HTMLSelectElement>('global-viewport'),
  summary: $('frames-summary'),
  list: $<HTMLUListElement>('frames-list'),
  applyBtn: $<HTMLButtonElement>('apply-btn'),
  applyHint: $('apply-hint'),
  failures: $('failures'),
  failuresTitle: $('failures-title'),
  failuresList: $<HTMLUListElement>('failures-list'),
  cardTemplate: $<HTMLTemplateElement>('frame-card-template'),
  version: $('version'),
}

function post(message: unknown): void {
  parent.postMessage({ pluginMessage: message }, '*')
}

function isActionable(frame: FrameInfo): boolean {
  return !frame.isComponent && !frame.isLocked
}

function getState(frame: FrameInfo): FrameState {
  let st = frameState.get(frame.id)
  if (!st) {
    st = { feature: '', viewport: frame.inferredViewport, flow: frame.contentName }
    frameState.set(frame.id, st)
  }
  return st
}

/** State with global overrides applied. Globals win only where they are set. */
function effectiveState(frame: FrameInfo): FrameState {
  const st = getState(frame)
  return {
    feature: globals.feature ?? st.feature,
    viewport: globals.viewport ?? st.viewport,
    flow: st.flow,
  }
}

function buildNames(): {
  final: Map<string, string | null>
  collisions: Set<string>
} {
  const proposals = new Map<string, string | null>()

  // Every frame is visited before collisions are resolved — the original
  // returned from inside this loop, so only the first frame was ever named.
  for (const frame of state.frames) {
    if (!isActionable(frame)) {
      proposals.set(frame.id, null)
      continue
    }
    proposals.set(frame.id, composeFrameName(effectiveState(frame)))
  }

  return resolveCollisions(proposals)
}

function canApply(): boolean {
  if (!state.layersRenamed) return false
  const actionable = state.frames.filter(isActionable)
  if (!actionable.length) return false
  const { final } = buildNames()
  return actionable.every((frame) => final.get(frame.id) !== null)
}

/* ── Step 1 ──────────────────────────────────────────────────────────── */

function renderStep1(): void {
  const actionable = state.frames.filter(isActionable)
  const layers = actionable.reduce((sum, f) => sum + f.renamableLayerCount, 0)
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

  if (state.layersRenamed) {
    els.step1Desc.innerHTML =
      `<strong>${plural(layers, 'layer')}</strong> renamed across ` +
      `<strong>${plural(actionable.length, 'frame')}</strong>.`
    els.renameBtn.disabled = true
    els.step1Hint.textContent = ''
    els.badge1.className = 'badge done'
    return
  }

  els.badge1.className = 'badge active'

  if (!actionable.length) {
    els.step1Desc.textContent = state.frames.length
      ? 'Selected frames are components or locked, so they are skipped.'
      : 'Select frames to begin.'
    els.renameBtn.disabled = true
    els.step1Hint.textContent = ''
    return
  }

  els.step1Desc.innerHTML =
    `Renames child layers in <strong>${plural(actionable.length, 'frame')}</strong> ` +
    'to semantic slot names — <em>_label, _cta, _bg…</em>'
  els.renameBtn.disabled = false
  els.step1Hint.textContent = `${plural(layers, 'layer')} will be renamed`
}

/* ── Step 2 ──────────────────────────────────────────────────────────── */

function populateViewportSelect(select: HTMLSelectElement, includeKeep: boolean): void {
  select.textContent = ''
  if (includeKeep) {
    const keep = document.createElement('option')
    keep.value = ''
    keep.textContent = 'Keep per-frame'
    select.append(keep)
  }
  for (const viewport of VIEWPORTS) {
    const option = document.createElement('option')
    option.value = viewport
    option.textContent = VIEWPORT_LABELS[viewport]
    select.append(option)
  }
}

/** Live card elements by frame id, so rendering updates rather than rebuilds. */
const cards = new Map<string, HTMLElement>()

function createCard(frame: FrameInfo): HTMLElement {
  const fragment = els.cardTemplate.content.cloneNode(true) as DocumentFragment
  const card = fragment.querySelector<HTMLElement>('[data-card]')!
  card.dataset.fid = frame.id

  const viewportSelect = card.querySelector<HTMLSelectElement>('[data-input="viewport"]')!
  populateViewportSelect(viewportSelect, false)

  // Labels need ids unique per card to stay associated with their inputs.
  const labels = Array.from(card.querySelectorAll<HTMLLabelElement>('[data-label-for]'))
  for (const label of labels) {
    const key = label.dataset.labelFor!
    const input = card.querySelector<HTMLElement>(`[data-input="${key}"]`)!
    const id = `f-${frame.id.replace(/[^a-zA-Z0-9]/g, '-')}-${key}`
    input.id = id
    label.htmlFor = id
  }

  const featureInput = card.querySelector<HTMLInputElement>('[data-input="feature"]')!
  const flowInput = card.querySelector<HTMLInputElement>('[data-input="flow"]')!

  // 'input' keeps state current per keystroke; render() updates the preview
  // without touching the focused field, so the caret is never disturbed.
  featureInput.addEventListener('input', () => {
    globals.feature = null
    getState(frame).feature = featureInput.value
    render()
  })
  flowInput.addEventListener('input', () => {
    getState(frame).flow = flowInput.value
    render()
  })
  viewportSelect.addEventListener('change', () => {
    globals.viewport = null
    getState(frame).viewport = viewportSelect.value
    render()
  })

  return card
}

function updateCard(
  card: HTMLElement,
  frame: FrameInfo,
  finalName: string | null,
  collides: boolean,
): void {
  const actionable = isActionable(frame)
  card.classList.toggle('skipped', !actionable)

  card.querySelector('[data-card-name]')!.textContent = frame.name

  const flag = card.querySelector<HTMLElement>('[data-card-flag]')!
  const flagText = frame.isComponent
    ? 'component — skipped'
    : frame.isLocked
      ? 'locked — skipped'
      : collides
        ? 'duplicate name — numbered'
        : ''
  flag.textContent = flagText
  flag.hidden = !flagText

  const preview = card.querySelector<HTMLElement>('[data-card-preview]')!
  const eff = effectiveState(frame)
  if (!actionable) {
    preview.textContent = 'Name unchanged'
    preview.className = 'card-preview'
  } else if (finalName) {
    preview.textContent = finalName
    preview.className = 'card-preview ready'
  } else {
    preview.textContent = missingFieldsMessage(frame, eff)
    preview.className = 'card-preview warn'
  }

  if (!actionable) return

  // Only write to a field the user is not currently editing.
  const feature = card.querySelector<HTMLInputElement>('[data-input="feature"]')!
  const flow = card.querySelector<HTMLInputElement>('[data-input="flow"]')!
  const viewport = card.querySelector<HTMLSelectElement>('[data-input="viewport"]')!

  setIfNotFocused(feature, eff.feature)
  setIfNotFocused(flow, eff.flow)
  if (viewport.value !== eff.viewport) viewport.value = eff.viewport

  feature.placeholder = globals.feature ? 'set for all frames' : 'e.g. checkout'
}

function setIfNotFocused(input: HTMLInputElement, value: string): void {
  if (document.activeElement === input) return
  if (input.value !== value) input.value = value
}

function missingFieldsMessage(frame: FrameInfo, st: FrameState): string {
  const missing: string[] = []
  if (!toKebab(st.feature)) missing.push('feature')
  if (!st.viewport) missing.push('viewport')
  if (!toKebab(st.flow)) {
    missing.push(
      frame.contentUnrepresentable && !st.flow
        ? 'flow (frame text cannot be auto-named — type one)'
        : 'flow',
    )
  }
  return `Needs ${missing.join(', ')}`
}

function renderStep2(): void {
  const locked = !state.layersRenamed
  els.step2.classList.toggle('locked', locked)
  els.badge2.className = locked ? 'badge' : 'badge active'

  if (locked) {
    // Drop stale cards so re-entering step 2 rebuilds against fresh frames.
    cards.clear()
    els.list.textContent = ''
    return
  }

  const { final, collisions } = buildNames()
  const actionable = state.frames.filter(isActionable)

  els.summary.textContent = actionable.length
    ? `${actionable.length} frame${actionable.length === 1 ? '' : 's'} to rename`
    : 'No frames available to rename.'

  // Reconcile the list in place: reuse existing cards, append new ones, drop
  // the rest. Rebuilding via innerHTML would destroy the focused input.
  const wanted = state.frames.map((f) => f.id)
  for (const [id, card] of cards) {
    if (!wanted.includes(id)) {
      card.remove()
      cards.delete(id)
    }
  }

  state.frames.forEach((frame, index) => {
    let card = cards.get(frame.id)
    if (!card) {
      card = createCard(frame)
      cards.set(frame.id, card)
    }
    updateCard(card, frame, final.get(frame.id) ?? null, collisions.has(frame.id))
    // Keep DOM order matching selection order.
    if (els.list.children[index] !== card) {
      els.list.insertBefore(card, els.list.children[index] ?? null)
    }
  })

  const ready = canApply()
  els.applyBtn.disabled = !ready
  els.applyHint.textContent = ready
    ? ''
    : actionable.length
      ? 'Fill feature and flow for every frame'
      : ''

  if (globals.viewport !== null && els.globalViewport.value !== globals.viewport) {
    els.globalViewport.value = globals.viewport
  }
}

function renderFailures(): void {
  const result = state.lastApply
  if (!result || !result.failures.length) {
    els.failures.hidden = true
    return
  }
  els.failures.hidden = false
  const n = result.failures.length
  els.failuresTitle.textContent = `${n} frame${n === 1 ? '' : 's'} skipped`
  els.failuresList.textContent = ''
  for (const failure of result.failures) {
    const frame = state.frames.find((f) => f.id === failure.id)
    const li = document.createElement('li')
    li.textContent = frame ? `${frame.name} — ${failure.reason}` : failure.reason
    els.failuresList.append(li)
  }
}

function render(): void {
  const hasSelection = state.frames.length > 0
  els.empty.hidden = hasSelection
  els.step1.hidden = !hasSelection
  els.step2.hidden = !hasSelection

  if (hasSelection) {
    renderStep1()
    renderStep2()
  }
  renderFailures()
  reportHeight()
}

/* ── Step open/close ─────────────────────────────────────────────────── */

function applyStepOpen(): void {
  els.step1.classList.toggle('collapsed', !state.step1Open)
  els.step2.classList.toggle('collapsed', !state.step2Open)
  els.step1Header.setAttribute('aria-expanded', String(state.step1Open))
  els.step2Header.setAttribute('aria-expanded', String(state.step2Open))
}

function bindStepToggle(header: HTMLElement, toggle: () => void): void {
  const run = () => {
    toggle()
    applyStepOpen()
    reportHeight()
  }
  header.addEventListener('click', run)
  header.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault()
      run()
    }
  })
}

bindStepToggle(els.step1Header, () => {
  state.step1Open = !state.step1Open
})
bindStepToggle(els.step2Header, () => {
  state.step2Open = !state.step2Open
})

/* ── Globals ─────────────────────────────────────────────────────────── */

els.globalFeature.addEventListener('input', () => {
  const value = els.globalFeature.value
  // An empty global is "unset", so per-frame values come back into effect.
  globals.feature = value === '' ? null : value
  render()
})

populateViewportSelect(els.globalViewport, true)
els.globalViewport.addEventListener('change', () => {
  const value = els.globalViewport.value
  globals.viewport = value === '' ? null : (value as Viewport)
  render()
})

/* ── Actions ─────────────────────────────────────────────────────────── */

els.renameBtn.addEventListener('click', () => {
  els.renameBtn.disabled = true
  post({ type: 'rename-layers' })
})

els.applyBtn.addEventListener('click', () => {
  const { final } = buildNames()
  const renames: Array<{ id: string; newName: string }> = []
  for (const frame of state.frames) {
    const name = final.get(frame.id)
    if (isActionable(frame) && name) renames.push({ id: frame.id, newName: name })
  }
  if (!renames.length) return
  els.applyBtn.disabled = true
  post({ type: 'apply', renames })
})

/* ── Height reporting ────────────────────────────────────────────────── */

let lastHeight = 0
function reportHeight(): void {
  const height = Math.ceil(els.root.getBoundingClientRect().height) + 2
  if (height === lastHeight) return
  lastHeight = height
  post({ type: 'resize', height })
}

/* ── Messages from the plugin ────────────────────────────────────────── */

function onFrames(frames: FrameInfo[]): void {
  state.frames = frames

  // Seed state for new frames; existing entries keep whatever the user typed.
  for (const frame of frames) getState(frame)

  // A selection change means the previous run's results no longer describe
  // what is selected, so step 1 must be redone — but typed input survives.
  state.layersRenamed = false
  state.lastApply = null
  state.step2Open = false
  state.step1Open = true
  applyStepOpen()
  render()
}

window.onmessage = (event: MessageEvent) => {
  const msg = event.data?.pluginMessage as PluginMessage | undefined
  if (!msg) return

  switch (msg.type) {
    case 'init':
    case 'selection-change':
      if (msg.version) {
        els.version.textContent = `v${msg.version}`
        els.version.hidden = false
      }
      onFrames(msg.frames ?? [])
      return

    case 'layers-renamed':
      state.layersRenamed = true
      state.step1Open = false
      state.step2Open = true
      applyStepOpen()
      render()
      return

    case 'apply-done':
      state.lastApply = { count: msg.count ?? 0, failures: msg.failures ?? [] }
      render()
      return
  }
}

post({ type: 'ready' })
