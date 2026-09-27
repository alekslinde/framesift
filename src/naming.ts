export const MAX_SEGMENT = 30

/**
 * Accented Latin characters that have an unambiguous ASCII equivalent. Applied
 * before the non-ASCII strip so "Über Café" becomes "uber-cafe" rather than
 * "ber-caf". Scripts with no such mapping (CJK, Cyrillic, Arabic, …) are
 * deliberately absent: guessing a romanisation would produce a plausible but
 * wrong name, so those inputs are reported as unrepresentable instead.
 */
const LATIN_FOLD: Record<string, string> = {
  à: 'a', á: 'a', â: 'a', ã: 'a', ä: 'a', å: 'a', ā: 'a', ă: 'a', ą: 'a',
  æ: 'ae',
  ç: 'c', ć: 'c', ĉ: 'c', ċ: 'c', č: 'c',
  ð: 'd', ď: 'd', đ: 'd',
  è: 'e', é: 'e', ê: 'e', ë: 'e', ē: 'e', ĕ: 'e', ė: 'e', ę: 'e', ě: 'e',
  ĝ: 'g', ğ: 'g', ġ: 'g', ģ: 'g',
  ĥ: 'h', ħ: 'h',
  ì: 'i', í: 'i', î: 'i', ï: 'i', ĩ: 'i', ī: 'i', ĭ: 'i', į: 'i', ı: 'i',
  ĵ: 'j',
  ķ: 'k',
  ĺ: 'l', ļ: 'l', ľ: 'l', ł: 'l',
  ñ: 'n', ń: 'n', ņ: 'n', ň: 'n',
  ò: 'o', ó: 'o', ô: 'o', õ: 'o', ö: 'o', ø: 'o', ō: 'o', ŏ: 'o', ő: 'o',
  œ: 'oe',
  ŕ: 'r', ŗ: 'r', ř: 'r',
  ś: 's', ŝ: 's', ş: 's', š: 's', ș: 's', ß: 'ss',
  ţ: 't', ť: 't', ŧ: 't', ț: 't',
  ù: 'u', ú: 'u', û: 'u', ü: 'u', ũ: 'u', ū: 'u', ŭ: 'u', ů: 'u', ű: 'u', ų: 'u',
  ŵ: 'w',
  ý: 'y', ÿ: 'y', ŷ: 'y',
  ź: 'z', ż: 'z', ž: 'z',
  þ: 'th',
}

function foldLatin(s: string): string {
  let out = ''
  for (const ch of s) out += LATIN_FOLD[ch] ?? ch
  return out
}

/**
 * Lowercase, fold accents, collapse whitespace to dashes, drop anything that is
 * not a safe slug character, then trim separators. Truncation happens before
 * the final trim so a clipped name can never end in a dash.
 */
export function toKebab(input: string, maxLength = MAX_SEGMENT): string {
  const folded = foldLatin(String(input).toLowerCase().trim())
  const slug = folded
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-_]/g, '')
    .replace(/-+/g, '-')
  return slug.slice(0, maxLength).replace(/^[-_]+|[-_]+$/g, '')
}

/**
 * True when the input has visible content but nothing survives slugification —
 * i.e. the text is entirely in a script this tool cannot transliterate. Callers
 * surface this to the user rather than substituting a placeholder.
 */
export function isUnrepresentable(input: string): boolean {
  const raw = String(input).trim()
  if (!raw) return false
  return toKebab(raw) === ''
}

export interface FrameNameParts {
  feature: string
  viewport: string
  flow: string
}

/** Assembles `feature_viewport_flow`, or null when any part is missing. */
export function composeFrameName(parts: FrameNameParts): string | null {
  const feature = toKebab(parts.feature)
  const flow = toKebab(parts.flow)
  const viewport = String(parts.viewport ?? '').trim()
  if (!feature || !flow || !viewport) return null
  return `${feature}_${viewport}_${flow}`
}

/**
 * Assigns each id a unique final name. Entries with a null proposal stay null.
 *
 * The suffix counter checks its own output against every name already taken —
 * including names the user typed by hand — so de-duplicating `x, x` alongside a
 * literal `x_2` yields `x, x_3, x_2` rather than colliding again on `x_2`.
 */
export function resolveCollisions(
  proposals: ReadonlyMap<string, string | null>,
): { final: Map<string, string | null>; collisions: Set<string> } {
  const counts = new Map<string, number>()
  for (const name of proposals.values()) {
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
  }

  const collisions = new Set<string>()
  for (const [id, name] of proposals) {
    if (name && (counts.get(name) ?? 0) > 1) collisions.add(id)
  }

  // Every distinct proposal is reserved up front, so a generated suffix can
  // never land on a name the user typed for another frame.
  const reserved = new Set<string>()
  for (const name of proposals.values()) if (name) reserved.add(name)

  const taken = new Set<string>()
  const nextIndex = new Map<string, number>()
  const final = new Map<string, string | null>()

  for (const [id, name] of proposals) {
    if (!name) {
      final.set(id, null)
      continue
    }
    if ((counts.get(name) ?? 0) === 1) {
      final.set(id, name)
      taken.add(name)
      continue
    }
    let n = nextIndex.get(name) ?? 1
    let candidate = n === 1 ? name : `${name}_${n}`
    while (taken.has(candidate) || (n > 1 && reserved.has(candidate))) {
      n += 1
      candidate = `${name}_${n}`
    }
    nextIndex.set(name, n + 1)
    taken.add(candidate)
    final.set(id, candidate)
  }

  return { final, collisions }
}
