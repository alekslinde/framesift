import { describe, expect, test } from 'vitest'
import {
  classify,
  isGenerated,
  markGenerated,
  slotFromName,
  tokenize,
} from '../src/classify'

describe('tokenize', () => {
  test('splits separators, camel case and digits', () => {
    expect(tokenize('Nav Item 3')).toEqual(['nav', 'item'])
    expect(tokenize('navItem')).toEqual(['nav', 'item'])
    expect(tokenize('nav-item')).toEqual(['nav', 'item'])
    expect(tokenize('nav_item')).toEqual(['nav', 'item'])
    expect(tokenize('Rectangle 12')).toEqual(['rectangle'])
    expect(tokenize('123')).toEqual([])
  })
})

describe('slotFromName — regressions from review', () => {
  test('default Figma names do not match keywords hidden inside them', () => {
    // "re-CTA-ngle": the substring bug that renamed every default rectangle.
    expect(slotFromName('Rectangle 12')).toBeNull()
    expect(slotFromName('Rectangle')).toBeNull()
  })

  test('specific keywords win over generic substrings', () => {
    expect(slotFromName('subtitle')).toBe('subtitle')
    expect(slotFromName('Subtitle 2')).toBe('subtitle')
    expect(slotFromName('textfield')).toBe('field')
    expect(slotFromName('navigation')).toBe('nav')
    expect(slotFromName('chip')).toBe('chip')
  })

  test('multi-token names resolve to the most specific token', () => {
    expect(slotFromName('chip-tag')).toBe('chip')
    expect(slotFromName('list item')).toBe('item')
    // Longest keyword wins: "background" (10) over "image" (5).
    expect(slotFromName('Background Image')).toBe('bg')
    // "navigation" (10) over "icon" (4).
    expect(slotFromName('navigation-icon')).toBe('nav')
  })

  test('separated compounds match; run-together ones are not guessed at', () => {
    // tokenize splits these, so the keyword is a whole token.
    expect(slotFromName('navItem')).toBe('item')
    expect(slotFromName('nav-item')).toBe('item')
    expect(slotFromName('ctaButton')).toBe('cta')

    // No separator, no match: matching inside a token is what made "rectangle"
    // read as "cta". These fall through to the node-type slot instead.
    expect(slotFromName('navitem')).toBeNull()
    expect(slotFromName('ctabutton')).toBeNull()
  })

  test('unknown names yield no slot', () => {
    expect(slotFromName('Frame 1')).toBeNull()
    expect(slotFromName('')).toBeNull()
    expect(slotFromName('zzz')).toBeNull()
  })
})

describe('classify', () => {
  test('rectangles fall through to the type slot, not cta', () => {
    expect(classify({ type: 'RECTANGLE', name: 'Rectangle 12' })).toBe('bg')
  })

  test('text nodes use their content', () => {
    expect(classify({ type: 'TEXT', name: 'Text', textContent: 'Sign in' })).toBe('sign-in')
    expect(classify({ type: 'TEXT', name: 'Text', textContent: '   ' })).toBe('label')
  })

  test('image fills beat the name', () => {
    expect(classify({ type: 'RECTANGLE', name: 'button', hasImageFill: true })).toBe('image')
  })

  test('container role is used when the name says nothing', () => {
    expect(classify({ type: 'FRAME', name: 'Frame 4', containerRole: 'card' })).toBe('card')
    expect(classify({ type: 'FRAME', name: 'cta', containerRole: 'card' })).toBe('cta')
  })

  test('vector falls back to icon', () => {
    expect(classify({ type: 'VECTOR', name: 'Vector 9' })).toBe('icon')
  })
})

describe('the examples the UI promises', () => {
  // Step 1's explainer tells the user exactly what these produce. If the
  // classifier changes, the panel is lying — so the copy is pinned here.
  test.each([
    ['text layers use their own text', { type: 'TEXT', name: 'Text', textContent: 'Sign in' }, 'sign-in'],
    ['image fills become image', { type: 'RECTANGLE', name: 'Rectangle 4', hasImageFill: true }, 'image'],
    ['a recognised name becomes a role', { type: 'FRAME', name: 'Nav bar' }, 'nav'],
    ['a container is named from its contents', { type: 'FRAME', name: 'Frame 9', containerRole: 'card' }, 'card'],
    ['a rectangle falls back to bg', { type: 'RECTANGLE', name: 'Rectangle 12' }, 'bg'],
    ['a vector falls back to icon', { type: 'VECTOR', name: 'Vector 3' }, 'icon'],
  ])('%s', (_label, node, expected) => {
    expect(classify(node)).toBe(expected)
  })
})

describe('idempotence', () => {
  test('a second pass leaves generated names alone', () => {
    const first = markGenerated('text-block')
    expect(isGenerated(first)).toBe(true)
    // Old behaviour: "text-block" matched "text" and degraded to "label".
    expect(classify({ type: 'FRAME', name: first, containerRole: 'label' })).toBe(first)
    expect(classify({ type: 'FRAME', name: markGenerated('button') })).toBe(markGenerated('button'))
  })

  test('classify is stable across repeated application', () => {
    const node = { type: 'FRAME', name: 'Frame 1', containerRole: 'text-block' }
    const once = markGenerated(classify(node))
    // Re-running over the already-renamed node must return it unchanged.
    expect(classify({ ...node, name: once })).toBe(once)
  })
})
