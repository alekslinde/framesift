export type Viewport =
  | 'watch'
  | 'mobile'
  | 'mobile-ls'
  | 'tablet'
  | 'tablet-ls'
  | 'desktop'

export const VIEWPORTS: readonly Viewport[] = [
  'watch',
  'mobile',
  'mobile-ls',
  'tablet',
  'tablet-ls',
  'desktop',
]

export const VIEWPORT_LABELS: Record<Viewport, string> = {
  watch: 'Watch',
  mobile: 'Mobile',
  'mobile-ls': 'Mobile landscape',
  tablet: 'Tablet',
  'tablet-ls': 'Tablet landscape',
  desktop: 'Desktop',
}

/**
 * Longest-edge thresholds. A frame is classified by its longest edge, then by
 * orientation — so a 375x812 portrait and an 812x375 landscape both read as
 * mobile-class devices rather than the landscape one being mistaken for a
 * tablet or desktop on width alone.
 */
const WATCH_MAX_EDGE = 250
const MOBILE_MAX_EDGE = 900
const TABLET_MAX_EDGE = 1400

export function inferViewport(width: number, height: number): Viewport {
  const w = Number.isFinite(width) && width > 0 ? width : 0
  const h = Number.isFinite(height) && height > 0 ? height : 0

  // Without a usable height we cannot judge orientation; fall back to width.
  if (h === 0) {
    if (w === 0) return 'desktop'
    if (w <= WATCH_MAX_EDGE) return 'watch'
    if (w <= 480) return 'mobile'
    if (w <= 834) return 'tablet'
    return 'desktop'
  }

  const longEdge = Math.max(w, h)
  const landscape = w > h

  if (longEdge <= WATCH_MAX_EDGE) return 'watch'
  if (longEdge <= MOBILE_MAX_EDGE) return landscape ? 'mobile-ls' : 'mobile'
  if (longEdge <= TABLET_MAX_EDGE) return landscape ? 'tablet-ls' : 'tablet'
  return 'desktop'
}
