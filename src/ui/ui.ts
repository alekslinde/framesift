import { composeFrameName, resolveCollisions, toKebab } from '../naming'
import { VIEWPORT_LABELS, VIEWPORTS, type Viewport } from '../viewport'
import type { FrameInfo } from '../code'

interface FrameState {
  feature: string
  viewport: string
  flow: string
}

interface PluginMessage {
  type: 'init' | 'selection-change' | 'layers-renamed' | 'apply-done' | 'error'
  frames?: FrameInfo[]
  count?: number
  failures?: Array<{ id: string; reason: string }>
  version?: string
  reason?: string
  action?: string
}

const state = {
  frames: [] as FrameInfo[],
  layersRenamed: false,
  step1Open: true,
  step2Open: false,
  lastApply: null as { count: number; failures: Array<{ id: string; reason: string }> } | null,
  lastError: null as string | null,
}

/**
 * Per-frame input, keyed by node id and persisted across selection changes so a
 * stray canvas click cannot discard what the user typed.
 *
 * Entries survive one selection change without the frame, then are dropped — so
 * reselecting a frame much later starts from its freshly inferred values rather
 * than something typed long ago, and the map cannot grow for the whole session.
 */
const frameState = new Map<string, FrameState>()

/** Ids absent from the current selection but whose state is kept one more cycle. */
let graceIds = new Set<string>()

function pruneFrameState(selectedIds: ReadonlySet<string>): void {
  for (const id of Array.from(frameState.keys())) {
    if (selectedIds.has(id)) continue
    // Absent for a second consecutive cycle: drop it.
    if (graceIds.has(id)) frameState.delete(id)
  }
  const nextGrace = new Set<string>()
  for (const id of frameState.keys()) {
    if (!selectedIds.has(id)) nextGrace.add(id)
  }
  graceIds = nextGrace

  // An override only means anything while its frame's state exists.
  for (const set of Object.values(overridden)) {
    for (const id of Array.from(set)) if (!frameState.has(id)) set.delete(id)
  }
  for (const id of Array.from(expanded)) if (!selectedIds.has(id)) expanded.delete(id)
}

/**
 * Values applied to every frame. `null` means "not set", which is distinct from
 * an empty string, so clearing a field restores per-frame values rather than
 * blanking them.
 *
 * These are a display layer only and are never written into `frameState`. That
 * is what keeps "Per frame" meaningful: a frame's own value is always either
 * what the user typed for it or what the plugin inferred, never a global that
 * was applied and then released.
 */
const globals: { feature: string | null; flow: string | null; viewport: string | null } = {
  feature: null,
  flow: null,
  viewport: null,
}

/** Frames the user has given an explicit per-frame value, which globals skip. */
const overridden = {
  feature: new Set<string>(),
  flow: new Set<string>(),
  viewport: new Set<string>(),
}

/** Frame ids whose card is expanded. Cards start collapsed. */
const expanded = new Set<string>()

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
  globalFlow: $<HTMLInputElement>('global-flow'),
  globalViewport: $<HTMLSelectElement>('global-viewport'),
  expandToggle: $<HTMLButtonElement>('expand-toggle'),
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

type Field = 'feature' | 'flow' | 'viewport'

/**
 * Marks one frame's field as explicitly set, so a global no longer applies to
 * it. The global keeps applying to every other frame, and nothing is written
 * into the frames it does not touch — so releasing the global later restores
 * their own values intact.
 */
function setOverride(frame: FrameInfo, key: Field, value: string): void {
  overridden[key].add(frame.id)
  getState(frame)[key] = value
}

/**
 * What a frame will actually be named with: its own value where the user set
 * one, the global where one is set, and the frame's inferred value otherwise.
 */
function effectiveState(frame: FrameInfo): FrameState {
  const st = getState(frame)
  const pick = (key: Field): string => {
    if (overridden[key].has(frame.id)) return st[key]
    return globals[key] ?? st[key]
  }
  return {
    feature: pick('feature'),
    flow: pick('flow'),
    viewport: pick('viewport'),
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

/**
 * `keepLabel` adds a leading "not set" option. On the global select it reads
 * "Per frame" and means each frame keeps its own value; per-frame selects always
 * hold a concrete viewport and so get no such option.
 */
function populateViewportSelect(select: HTMLSelectElement, keepLabel?: string): void {
  select.textContent = ''
  if (keepLabel) {
    const keep = document.createElement('option')
    keep.value = ''
    keep.textContent = keepLabel
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
  populateViewportSelect(viewportSelect)

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
    setOverride(frame, 'feature', featureInput.value)
    render()
  })
  flowInput.addEventListener('input', () => {
    setOverride(frame, 'flow', flowInput.value)
    render()
  })
  viewportSelect.addEventListener('change', () => {
    setOverride(frame, 'viewport', viewportSelect.value)
    render()
  })

  card.querySelector<HTMLButtonElement>('[data-card-toggle]')!.addEventListener('click', () => {
    if (expanded.has(frame.id)) expanded.delete(frame.id)
    else expanded.add(frame.id)
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

  // The old name is secondary once a new one exists; the header leads with the
  // result so a long list can be scanned without opening anything.
  card.querySelector('[data-card-name]')!.textContent = frame.name

  const flag = card.querySelector<HTMLElement>('[data-card-flag]')!
  const flagText = frame.isComponent
    ? 'component'
    : frame.isLocked
      ? 'locked'
      : collides
        ? 'numbered'
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

  const toggle = card.querySelector<HTMLButtonElement>('[data-card-toggle]')!
  const fields = card.querySelector<HTMLElement>('[data-card-fields]')!
  // A skipped frame has nothing to edit, so its card does not open.
  const isOpen = actionable && expanded.has(frame.id)
  toggle.setAttribute('aria-expanded', String(isOpen))
  toggle.disabled = !actionable
  fields.hidden = !isOpen
  card.classList.toggle('open', isOpen)

  if (!actionable) return

  // Only write to a field the user is not currently editing.
  const feature = card.querySelector<HTMLInputElement>('[data-input="feature"]')!
  const flow = card.querySelector<HTMLInputElement>('[data-input="flow"]')!
  const viewport = card.querySelector<HTMLSelectElement>('[data-input="viewport"]')!

  setIfNotFocused(feature, eff.feature)
  setIfNotFocused(flow, eff.flow)
  if (viewport.value !== eff.viewport) viewport.value = eff.viewport

  feature.placeholder = globals.feature ?? 'e.g. checkout'
  flow.placeholder = globals.flow ?? 'e.g. guest-checkout'
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
  const ready = actionable.filter((f) => final.get(f.id)).length

  els.summary.textContent = actionable.length
    ? `${ready} of ${actionable.length} frame${actionable.length === 1 ? '' : 's'} ready`
    : 'No frames available to rename.'

  // With a long selection the per-frame cards are mostly noise, so offer one
  // control rather than making the user click thirty chevrons.
  const anyOpen = actionable.some((f) => expanded.has(f.id))
  els.expandToggle.hidden = actionable.length < 2
  els.expandToggle.textContent = anyOpen ? 'Collapse all' : 'Edit individually'

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

  const canRename = canApply()
  els.applyBtn.disabled = !canRename
  els.applyHint.textContent = canRename
    ? ''
    : actionable.length
      ? 'Set a feature and flow for every frame'
      : ''

  // Globals are a display layer, so the inputs are only corrected when they have
  // drifted — never rewritten from per-frame state.
  const wantViewport = globals.viewport ?? ''
  if (els.globalViewport.value !== wantViewport) els.globalViewport.value = wantViewport
  setIfNotFocused(els.globalFeature, globals.feature ?? '')
  setIfNotFocused(els.globalFlow, globals.flow ?? '')
}

function renderFailures(): void {
  if (state.lastError) {
    els.failures.hidden = false
    els.failuresTitle.textContent = 'Something went wrong'
    els.failuresList.textContent = ''
    const li = document.createElement('li')
    li.textContent = state.lastError
    els.failuresList.append(li)
    return
  }

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

/**
 * Typing in a global re-applies it to every frame that has no explicit value of
 * its own, and clearing it ("" → null) hands those frames back their own.
 * Frames the user edited individually keep their override either way.
 */
function bindGlobalText(input: HTMLInputElement, key: 'feature' | 'flow'): void {
  input.addEventListener('input', () => {
    globals[key] = input.value === '' ? null : input.value
    render()
  })
}

bindGlobalText(els.globalFeature, 'feature')
bindGlobalText(els.globalFlow, 'flow')

populateViewportSelect(els.globalViewport, 'Per frame')
els.globalViewport.addEventListener('change', () => {
  const value = els.globalViewport.value
  globals.viewport = value === '' ? null : (value as Viewport)
  render()
})

els.expandToggle.addEventListener('click', () => {
  const actionable = state.frames.filter(isActionable)
  if (actionable.some((f) => expanded.has(f.id))) expanded.clear()
  else for (const frame of actionable) expanded.add(frame.id)
  render()
})

/* ── Actions ─────────────────────────────────────────────────────────── */

els.renameBtn.addEventListener('click', () => {
  state.lastError = null
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
  state.lastError = null
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
  pruneFrameState(new Set(frames.map((f) => f.id)))

  // A selection change means the previous run's results no longer describe
  // what is selected, so step 1 must be redone — but typed input survives.
  state.layersRenamed = false
  state.lastApply = null
  state.lastError = null
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

    case 'error':
      // Buttons are disabled optimistically on post, so render() must run to
      // restore them from actual state rather than leaving the step stuck.
      state.lastError = msg.reason ?? 'Something went wrong'
      render()
      return
  }
}

post({ type: 'ready' })
