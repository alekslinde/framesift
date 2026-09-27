import { describe, expect, test } from 'vitest'
import { MAX_RENAME_DEPTH } from '../src/classify'
import {
  countRenamable,
  isProtected,
  walkRenamable,
  type TraversableNode,
} from '../src/traverse'

type Node = TraversableNode & { children?: Node[] }

const node = (id: string, over: Partial<Node> = {}): Node => ({
  id,
  type: 'FRAME',
  ...over,
})

/** Ids that a fresh walk would visit. */
const visited = (roots: Node[], seen = new Set<string>()): string[] => {
  const ids: string[] = []
  walkRenamable(roots, seen, (n) => ids.push(n.id))
  return ids
}

describe('isProtected', () => {
  test('covers components, component sets, instances and locked nodes', () => {
    expect(isProtected(node('a', { type: 'COMPONENT' }))).toBe(true)
    expect(isProtected(node('a', { type: 'COMPONENT_SET' }))).toBe(true)
    expect(isProtected(node('a', { type: 'INSTANCE' }))).toBe(true)
    expect(isProtected(node('a', { locked: true }))).toBe(true)
    expect(isProtected(node('a'))).toBe(false)
  })
})

describe('protected roots', () => {
  test('a component root is never descended into', () => {
    // The plugin promises component internals are untouched; walking into them
    // would edit library content the user did not select for renaming.
    const root = node('c', {
      type: 'COMPONENT',
      children: [node('c1'), node('c2')],
    })
    expect(visited([root])).toEqual([])
  })

  test('a locked root is never descended into', () => {
    const root = node('l', { locked: true, children: [node('l1')] })
    expect(visited([root])).toEqual([])
  })

  test('an instance root is never descended into', () => {
    const root = node('i', { type: 'INSTANCE', children: [node('i1')] })
    expect(visited([root])).toEqual([])
  })

  test('unprotected roots alongside protected ones still process', () => {
    const roots = [
      node('c', { type: 'COMPONENT', children: [node('c1')] }),
      node('f', { children: [node('f1')] }),
    ]
    expect(visited(roots)).toEqual(['f1'])
  })
})

describe('protected children', () => {
  test('are skipped along with their subtrees', () => {
    const root = node('r', {
      children: [
        node('keep'),
        node('inst', { type: 'INSTANCE', children: [node('inst-child')] }),
        node('lock', { locked: true, children: [node('lock-child')] }),
      ],
    })
    expect(visited([root])).toEqual(['keep'])
  })
})

describe('depth limit', () => {
  test(`descends ${MAX_RENAME_DEPTH} levels of children`, () => {
    // r > d1 > d2 > d3 > d4
    const root = node('r', {
      children: [
        node('d1', {
          children: [node('d2', { children: [node('d3', { children: [node('d4')] })] })],
        }),
      ],
    })
    expect(visited([root])).toEqual(['d1', 'd2', 'd3'])
  })
})

describe('count and rename agree', () => {
  /** Both passes run over one shared `seen` set, as the plugin does. */
  const countThenRename = (roots: Node[]) => {
    const countSeen = new Set<string>()
    const count = roots.reduce((sum, root) => sum + countRenamable([root], countSeen), 0)
    const renamed = visited(roots, new Set<string>())
    return { count, renamed: renamed.length }
  }

  test('for a plain selection', () => {
    const roots = [node('a', { children: [node('a1'), node('a2')] })]
    const { count, renamed } = countThenRename(roots)
    expect(count).toBe(renamed)
  })

  test('when a parent and its own child are both selected', () => {
    // The overlapping case: 'child' is both a root and a descendant of 'parent'.
    const child = node('child', { children: [node('grandchild')] })
    const parent = node('parent', { children: [child] })
    const { count, renamed } = countThenRename([parent, child])
    expect(count).toBe(renamed)
  })

  test('when a locked parent and its child frame are both selected', () => {
    // Previously the count skipped the locked root without seeding `seen`, while
    // the rename walked it — so the two disagreed on the depth budget left for
    // the separately-selected child.
    const child = node('child', { children: [node('g1', { children: [node('g2')] })] })
    const locked = node('locked', { locked: true, children: [child] })
    const { count, renamed } = countThenRename([locked, child])
    expect(count).toBe(renamed)
  })

  test('when a component parent and its child frame are both selected', () => {
    const child = node('child', { children: [node('g1')] })
    const component = node('comp', { type: 'COMPONENT', children: [child] })
    const { count, renamed } = countThenRename([component, child])
    expect(count).toBe(renamed)
  })
})

describe('shared seen set', () => {
  test('visits each node once across overlapping roots', () => {
    const child = node('child', { children: [node('grandchild')] })
    const parent = node('parent', { children: [child] })
    const ids = visited([parent, child])
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('a duplicated root is not double-counted', () => {
    const root = node('r', { children: [node('r1')] })
    expect(visited([root, root])).toEqual(['r1'])
  })
})

describe('nodes without children', () => {
  test('are handled without error', () => {
    expect(visited([node('leaf', { type: 'RECTANGLE' })])).toEqual([])
    expect(countRenamable([node('leaf')], new Set())).toBe(0)
  })
})
