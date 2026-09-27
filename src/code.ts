import { classify, isGenerated, markGenerated } from './classify'
import { isUnrepresentable, toKebab } from './naming'
import {
  countRenamable,
  isComponentType,
  isNodeLocked,
  walkRenamable,
} from './traverse'
import { inferViewport, type Viewport } from './viewport'

/** Replaced at build time with the version from package.json. */
declare const __PLUGIN_VERSION__: string

const UI_WIDTH = 400
const UI_MIN_HEIGHT = 240
const UI_MAX_HEIGHT = 900
const CONTENT_NAME_MAX = 40

export interface FrameInfo {
  id: string
  name: string
  width: number
  height: number
  inferredViewport: Viewport
  isLocked: boolean
  isComponent: boolean
  contentName: string
  /** True when the frame's text is in a script this tool cannot slugify. */
  contentUnrepresentable: boolean
  renamableLayerCount: number
}

type UIMessage =
  | { type: 'ready' }
  | { type: 'resize'; height: number }
  | { type: 'rename-layers' }
  | { type: 'apply'; renames: Array<{ id: string; newName: string }> }

function hasImageFill(node: SceneNode): boolean {
  if (!('fills' in node) || !Array.isArray(node.fills)) return false
  return (node.fills as ReadonlyArray<Paint>).some((f) => f.type === 'IMAGE')
}

function childrenOf(node: SceneNode): readonly SceneNode[] {
  return 'children' in node ? node.children : []
}

function inferContainerRole(node: SceneNode): string {
  const children = childrenOf(node)
  const total = children.length
  if (total === 0) return 'container'

  const textNodes = children.filter((c) => c.type === 'TEXT')
  const imageNodes = children.filter((c) => hasImageFill(c))
  const vectorNodes = children.filter(
    (c) => c.type === 'VECTOR' || c.type === 'BOOLEAN_OPERATION',
  )
  const frameNodes = children.filter(
    (c) => c.type === 'FRAME' || c.type === 'INSTANCE' || c.type === 'GROUP',
  )
  const shapeNodes = children.filter(
    (c) => c.type === 'RECTANGLE' || c.type === 'ELLIPSE',
  )

  if (total === 1 && (vectorNodes.length === 1 || (shapeNodes.length === 1 && !imageNodes.length))) {
    return 'icon'
  }
  if (imageNodes.length > 0 && total <= 2 && textNodes.length === 0) return 'image'
  if (imageNodes.length > 0 && textNodes.length > 0) return 'card'
  if (frameNodes.length >= 3 && textNodes.length === 0) return 'list'

  if (textNodes.length >= 1 && shapeNodes.length >= 1 && frameNodes.length === 0) {
    const width = 'width' in node ? node.width : 0
    const height = 'height' in node ? node.height : 0
    if (textNodes.length === 1) return width > height * 1.5 ? 'field' : 'button'
  }

  if (
    textNodes.length >= 1 &&
    shapeNodes.length === 0 &&
    frameNodes.length === 0 &&
    vectorNodes.length === 0
  ) {
    return textNodes.length === 1 ? 'label' : 'text-block'
  }

  if (frameNodes.length >= 3) return 'list'
  if (shapeNodes.length >= 1 && (textNodes.length > 0 || frameNodes.length > 0)) return 'card'
  return 'container'
}

function slotForNode(node: SceneNode): string {
  const isContainer = node.type === 'FRAME' || node.type === 'GROUP'
  return classify({
    type: node.type,
    name: node.name,
    hasImageFill: hasImageFill(node),
    textContent: node.type === 'TEXT' ? node.characters : undefined,
    containerRole: isContainer ? inferContainerRole(node) : undefined,
  })
}

/** The largest text in a frame, used to suggest a flow name. */
function findHeadlineText(node: SceneNode): string {
  let best = ''
  let bestSize = -1

  const walk = (n: SceneNode, depth: number): void => {
    if (depth > 5) return
    if (n.type === 'TEXT') {
      const chars = n.characters.trim()
      const size = typeof n.fontSize === 'number' ? n.fontSize : 12
      if (chars && size > bestSize) {
        best = chars
        bestSize = size
      }
    }
    for (const child of childrenOf(n)) walk(child, depth + 1)
  }

  for (const child of childrenOf(node)) walk(child, 1)
  return best
}

function buildFrameInfo(node: SceneNode, seen: Set<string>): FrameInfo {
  const isComponent = isComponentType(node.type)
  const isLocked = isNodeLocked(node)
  const width = 'width' in node ? node.width : 0
  const height = 'height' in node ? node.height : 0

  // No guard here: walkRenamable skips protected roots itself, so this count and
  // the rename pass mark the same nodes in the shared `seen` set and cannot
  // disagree about the remaining depth budget for an overlapping selection.
  const renamableLayerCount = countRenamable([node], seen)

  const headline = findHeadlineText(node)
  const source = headline || node.name
  // A name the plugin generated is not a meaningful flow suggestion.
  const suggestion = isGenerated(source) ? '' : source

  return {
    id: node.id,
    name: node.name,
    width,
    height,
    inferredViewport: inferViewport(width, height),
    isLocked,
    isComponent,
    contentName: toKebab(suggestion, CONTENT_NAME_MAX),
    contentUnrepresentable: isUnrepresentable(suggestion),
    renamableLayerCount,
  }
}

function getSelectedFrames(): FrameInfo[] {
  // One `seen` set across the whole selection: when a frame and its own child
  // are both selected, each layer is attributed once, matching the rename pass.
  const counted = new Set<string>()
  const seenRoots = new Set<string>()
  const result: FrameInfo[] = []

  for (const node of figma.currentPage.selection) {
    if (seenRoots.has(node.id)) continue
    seenRoots.add(node.id)
    result.push(buildFrameInfo(node, counted))
  }
  return result
}

function postSelection(type: 'init' | 'selection-change'): void {
  figma.ui.postMessage({
    type,
    frames: getSelectedFrames(),
    version: type === 'init' ? __PLUGIN_VERSION__ : undefined,
  })
}

function renameLayers(): { count: number; skipped: number } {
  const seen = new Set<string>()
  const targets: SceneNode[] = []
  walkRenamable(figma.currentPage.selection, seen, (node) => targets.push(node))

  let count = 0
  let skipped = 0
  for (const node of targets) {
    // A node can be removed between this snapshot and the write, which makes
    // every property access throw. One bad node must not abandon the rest.
    try {
      if (node.removed) {
        skipped += 1
        continue
      }
      const slot = slotForNode(node)
      // classify returns generated names unchanged; don't re-prefix them.
      const next = isGenerated(slot) ? slot : markGenerated(slot)
      if (node.name !== next) {
        node.name = next
      }
      count += 1
    } catch {
      skipped += 1
    }
  }
  return { count, skipped }
}

async function applyRenames(
  renames: ReadonlyArray<{ id: string; newName: string }>,
): Promise<{ count: number; failures: Array<{ id: string; reason: string }> }> {
  const failures: Array<{ id: string; reason: string }> = []
  let count = 0

  for (const { id, newName } of renames) {
    try {
      const node = await figma.getNodeByIdAsync(id)
      if (!node) {
        failures.push({ id, reason: 'Frame no longer exists' })
        continue
      }
      if (node.type === 'PAGE' || node.type === 'DOCUMENT') {
        failures.push({ id, reason: 'Not a frame' })
        continue
      }
      const scene = node as SceneNode
      if (isComponentType(scene.type)) {
        failures.push({ id, reason: 'Components and instances are skipped' })
        continue
      }
      if (isNodeLocked(scene)) {
        failures.push({ id, reason: 'Layer is locked' })
        continue
      }
      scene.name = newName
      count += 1
    } catch (error) {
      failures.push({
        id,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { count, failures }
}

figma.showUI(__html__, { width: UI_WIDTH, height: 520, themeColors: true })

figma.on('selectionchange', () => postSelection('selection-change'))

async function handleMessage(msg: UIMessage): Promise<void> {
  switch (msg.type) {
    case 'ready':
      postSelection('init')
      return

    case 'resize': {
      const height = Math.round(Number(msg.height) || UI_MIN_HEIGHT)
      figma.ui.resize(UI_WIDTH, Math.max(UI_MIN_HEIGHT, Math.min(UI_MAX_HEIGHT, height)))
      return
    }

    case 'rename-layers': {
      const { count, skipped } = renameLayers()
      figma.ui.postMessage({ type: 'layers-renamed', count })
      const suffix = skipped ? `, ${skipped} skipped` : ''
      figma.notify(`Renamed ${count} layer${count === 1 ? '' : 's'}${suffix}`)
      return
    }

    case 'apply': {
      const { count, failures } = await applyRenames(msg.renames ?? [])
      figma.ui.postMessage({ type: 'apply-done', count, failures })
      const suffix = failures.length ? `, ${failures.length} skipped` : ''
      figma.notify(`Renamed ${count} frame${count === 1 ? '' : 's'}${suffix}`)
      return
    }
  }
}

/**
 * The UI disables its buttons optimistically when it posts, so an unreported
 * throw here would leave a step permanently stuck. Every failure is surfaced to
 * the panel and the canvas instead.
 */
figma.ui.onmessage = async (raw: unknown) => {
  const msg = raw as UIMessage
  try {
    await handleMessage(msg)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    figma.ui.postMessage({ type: 'error', action: msg?.type, reason })
    figma.notify(`Renamely: ${reason}`, { error: true })
  }
}
