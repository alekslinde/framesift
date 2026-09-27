import { MAX_RENAME_DEPTH } from './classify'

/**
 * The structural shape traversal needs. Figma's SceneNode satisfies it, and so
 * do plain objects in tests — the traversal rules are worth testing without a
 * mock of the whole plugin API.
 */
export interface TraversableNode {
  id: string
  type: string
  locked?: boolean
  children?: readonly TraversableNode[]
}

export function isComponentType(type: string): boolean {
  return type === 'COMPONENT' || type === 'COMPONENT_SET' || type === 'INSTANCE'
}

export function isNodeLocked(node: TraversableNode): boolean {
  return node.locked === true
}

/** Nodes this plugin will not touch: components, instances, and locked layers. */
export function isProtected(node: TraversableNode): boolean {
  return isComponentType(node.type) || isNodeLocked(node)
}

function childrenOf(node: TraversableNode): readonly TraversableNode[] {
  return node.children ?? []
}

/**
 * Walks each root's descendants to the rename depth limit, invoking `visit` on
 * every node that would be renamed.
 *
 * Counting and renaming both go through here, sharing one `seen` set, so the
 * previewed count always matches what the rename does — including when the
 * selection overlaps (a frame and its own child both selected), where each layer
 * must be attributed exactly once.
 *
 * Protected roots are skipped whole rather than descended into: a component,
 * component set, instance or locked frame keeps its inner layers untouched. That
 * filter lives here, not in the callers, so the two passes cannot disagree.
 */
export function walkRenamable<T extends TraversableNode>(
  roots: readonly T[],
  seen: Set<string>,
  visit: (node: T) => void,
): void {
  const descend = (node: T, depth: number): void => {
    if (depth >= MAX_RENAME_DEPTH) return
    for (const child of childrenOf(node) as readonly T[]) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      if (isProtected(child)) continue
      visit(child)
      if (child.type !== 'INSTANCE') descend(child, depth + 1)
    }
  }

  for (const root of roots) {
    if (isProtected(root)) continue
    descend(root, 0)
  }
}

/** Counts what `walkRenamable` would rename, sharing the caller's `seen` set. */
export function countRenamable<T extends TraversableNode>(
  roots: readonly T[],
  seen: Set<string>,
): number {
  let count = 0
  walkRenamable(roots, seen, () => {
    count += 1
  })
  return count
}
