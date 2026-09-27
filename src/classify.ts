import { toKebab } from './naming'

/** How deep layer renaming descends into a frame. Shared by preview and apply. */
export const MAX_RENAME_DEPTH = 3

/**
 * Prefix marking names this plugin generated. Renaming is idempotent: a second
 * pass recognises its own output and leaves it alone rather than reclassifying
 * e.g. a frame it named "text-block" into "label".
 */
const GENERATED_PREFIX = '_'

export function markGenerated(slot: string): string {
  return `${GENERATED_PREFIX}${slot}`
}

export function isGenerated(name: string): boolean {
  return name.startsWith(GENERATED_PREFIX)
}

/** Semantic slot keywords, matched on word boundaries. */
const NAME_SLOTS: Record<string, string> = {
  text: 'label',
  label: 'label',
  title: 'title',
  heading: 'heading',
  subtitle: 'subtitle',
  body: 'body',
  caption: 'caption',
  input: 'field',
  field: 'field',
  textfield: 'field',
  button: 'cta',
  cta: 'cta',
  btn: 'cta',
  icon: 'icon',
  image: 'image',
  img: 'image',
  photo: 'image',
  avatar: 'avatar',
  header: 'header',
  navbar: 'nav',
  nav: 'nav',
  navigation: 'nav',
  footer: 'footer',
  card: 'card',
  modal: 'modal',
  dialog: 'modal',
  toast: 'toast',
  badge: 'badge',
  tag: 'tag',
  chip: 'chip',
  divider: 'divider',
  separator: 'divider',
  background: 'bg',
  bg: 'bg',
  container: 'container',
  wrapper: 'wrapper',
  list: 'list',
  item: 'item',
  overlay: 'overlay',
}

/** Fallback slot per node type, used when the name says nothing useful. */
const TYPE_SLOTS: Record<string, string> = {
  TEXT: 'label',
  RECTANGLE: 'bg',
  ELLIPSE: 'circle',
  LINE: 'divider',
  VECTOR: 'icon',
  BOOLEAN_OPERATION: 'shape',
  STAR: 'shape',
  POLYGON: 'shape',
  FRAME: 'container',
  GROUP: 'group',
}

/**
 * Keys longest-first, so a specific keyword wins over a generic one that is a
 * substring of it: "subtitle" beats "title", "textfield" beats "text" and
 * "field", "navigation" beats "nav". Insertion order of NAME_SLOTS no longer
 * affects the result.
 */
const ORDERED_KEYS = Object.keys(NAME_SLOTS).sort(
  (a, b) => b.length - a.length || a.localeCompare(b),
)

/**
 * Splits a layer name into lowercase word tokens. Camel case, digits, and the
 * usual separators all break words, so "navItem", "nav-item", "nav_item" and
 * "Nav Item 3" all yield ["nav", "item"].
 */
export function tokenize(name: string): string[] {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean)
}

/**
 * Matches a slot keyword against whole word tokens, longest keyword first.
 *
 * Matching is strictly token-equality — never substring. That is deliberate:
 * "rectangle" contains "cta", so any substring fallback renames every default
 * Figma rectangle to a call-to-action. Genuine compound names ("navItem",
 * "nav-item", "nav_item") are handled by tokenize splitting them into words, so
 * the only names this misses are run-together ones like "navitem", which fall
 * through to the node-type slot instead of being guessed at.
 */
export function slotFromName(name: string): string | null {
  const tokens = new Set(tokenize(name))
  if (!tokens.size) return null

  for (const key of ORDERED_KEYS) {
    if (tokens.has(key)) return NAME_SLOTS[key]
  }

  return null
}

export function slotFromType(type: string): string | null {
  return TYPE_SLOTS[type] ?? null
}

export interface ClassifiableNode {
  type: string
  name: string
  hasImageFill?: boolean
  textContent?: string
  containerRole?: string
}

/**
 * Resolves a node to its slot name. Order matters: text content and image fills
 * describe the node more reliably than its current name, and a name this plugin
 * generated is left untouched so repeat runs are stable.
 */
export function classify(node: ClassifiableNode): string {
  if (isGenerated(node.name)) return node.name

  if (node.type === 'TEXT') {
    const text = (node.textContent ?? '').trim()
    if (text) return toKebab(text) || 'label'
    return 'label'
  }

  if (node.hasImageFill) return 'image'

  const byName = slotFromName(node.name)
  if (byName) return byName

  if (node.containerRole) return node.containerRole

  const byType = slotFromType(node.type)
  if (byType) return byType

  return toKebab(node.name) || 'layer'
}
