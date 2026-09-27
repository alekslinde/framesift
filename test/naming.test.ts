import { describe, expect, test } from 'vitest'
import {
  composeFrameName,
  isUnrepresentable,
  resolveCollisions,
  toKebab,
} from '../src/naming'

describe('toKebab', () => {
  test('basic slugification', () => {
    expect(toKebab('Sign In')).toBe('sign-in')
    expect(toKebab('  Checkout  Flow  ')).toBe('checkout-flow')
    expect(toKebab('Order #12 / Review')).toBe('order-12-review')
  })

  test('folds accented Latin instead of dropping it', () => {
    // Old behaviour: "caf", "ber-caf".
    expect(toKebab('café')).toBe('cafe')
    expect(toKebab('Über Café')).toBe('uber-cafe')
    expect(toKebab('Straße')).toBe('strasse')
    expect(toKebab('Ærø')).toBe('aero')
  })

  test('truncation never leaves a trailing dash', () => {
    expect(toKebab('abcdefghijklmnopqrstuvwxyz abc')).not.toMatch(/-$/)
    expect(toKebab('a'.repeat(40))).toHaveLength(30)
    const clipped = toKebab('abcdefghijklmnopqrstuvwxyzab cd')
    expect(clipped.endsWith('-')).toBe(false)
  })

  test('respects a custom max length', () => {
    expect(toKebab('checkout-flow-review', 8)).toBe('checkout')
  })

  test('scripts with no mapping slugify to empty', () => {
    expect(toKebab('日本語')).toBe('')
    expect(toKebab('Привет')).toBe('')
  })
})

describe('isUnrepresentable', () => {
  test('flags text that cannot be slugified', () => {
    expect(isUnrepresentable('日本語')).toBe(true)
    expect(isUnrepresentable('!!!')).toBe(true)
  })

  test('does not flag empty or representable input', () => {
    expect(isUnrepresentable('')).toBe(false)
    expect(isUnrepresentable('   ')).toBe(false)
    expect(isUnrepresentable('café')).toBe(false)
    expect(isUnrepresentable('Sign In')).toBe(false)
  })
})

describe('composeFrameName', () => {
  test('joins the three parts', () => {
    expect(composeFrameName({ feature: 'Checkout', viewport: 'mobile', flow: 'Review Order' }))
      .toBe('checkout_mobile_review-order')
  })

  test('returns null when any part is missing', () => {
    expect(composeFrameName({ feature: '', viewport: 'mobile', flow: 'x' })).toBeNull()
    expect(composeFrameName({ feature: 'x', viewport: '', flow: 'x' })).toBeNull()
    expect(composeFrameName({ feature: 'x', viewport: 'mobile', flow: '' })).toBeNull()
    // Unrepresentable input is missing input, not a silent placeholder.
    expect(composeFrameName({ feature: '日本語', viewport: 'mobile', flow: 'x' })).toBeNull()
  })
})

describe('resolveCollisions', () => {
  const build = (entries: Array<[string, string | null]>) =>
    resolveCollisions(new Map(entries))

  test('unique names pass through untouched', () => {
    const { final, collisions } = build([['a', 'x'], ['b', 'y']])
    expect(final.get('a')).toBe('x')
    expect(final.get('b')).toBe('y')
    expect(collisions.size).toBe(0)
  })

  test('duplicates get numbered suffixes', () => {
    const { final, collisions } = build([['a', 'x'], ['b', 'x'], ['c', 'x']])
    expect([...final.values()]).toEqual(['x', 'x_2', 'x_3'])
    expect(collisions).toEqual(new Set(['a', 'b', 'c']))
  })

  test('a generated suffix never duplicates a user-typed name', () => {
    // The review's case: [x, x, x_2] previously produced x, x_2, x_2.
    const { final } = build([['a', 'x'], ['b', 'x'], ['c', 'x_2']])
    const names = [...final.values()]
    expect(new Set(names).size).toBe(names.length)
    expect(final.get('c')).toBe('x_2')
  })

  test('null proposals stay null and are not collisions', () => {
    const { final, collisions } = build([['a', null], ['b', null], ['c', 'x']])
    expect(final.get('a')).toBeNull()
    expect(final.get('b')).toBeNull()
    expect(collisions.size).toBe(0)
  })

  test('output is always collision-free', () => {
    const { final } = build([
      ['a', 'x'], ['b', 'x'], ['c', 'x_2'], ['d', 'x_3'], ['e', 'x'], ['f', null],
    ])
    const names = [...final.values()].filter((n): n is string => n !== null)
    expect(new Set(names).size).toBe(names.length)
  })
})
