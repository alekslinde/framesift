/**
 * Guards the shape of dist/ — the artifact that actually gets imported into
 * Figma. Requires a build first; `npm test` runs one via pretest.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const root = resolve(__dirname, '..')
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8')

const rootManifest = JSON.parse(read('manifest.json'))
const distManifest = JSON.parse(read('dist/manifest.json'))
const pkg = JSON.parse(read('package.json'))

describe('dist/manifest.json', () => {
  test('paths resolve beside the manifest, not through dist/', () => {
    // Figma resolves main/ui relative to the manifest's own location.
    expect(distManifest.main).toBe('code.js')
    expect(distManifest.ui).toBe('ui.html')
  })

  test('carries the package version', () => {
    expect(distManifest.version).toBe(pkg.version)
  })

  test('preserves the identity and permissions from the root manifest', () => {
    expect(distManifest.id).toBe(rootManifest.id)
    expect(distManifest.name).toBe(rootManifest.name)
    expect(distManifest.api).toBe(rootManifest.api)
    expect(distManifest.editorType).toEqual(rootManifest.editorType)
    expect(distManifest.documentAccess).toBe(rootManifest.documentAccess)
    expect(distManifest.networkAccess).toEqual(rootManifest.networkAccess)
  })

  test('declares no network access, matching what the plugin does', () => {
    expect(distManifest.networkAccess.allowedDomains).toEqual(['none'])
  })
})

describe('dist/ui.html', () => {
  const html = read('dist/ui.html')

  test('is self-contained — Figma cannot fetch external assets', () => {
    expect(html).not.toMatch(/<script[^>]+\bsrc=/i)
    expect(html).not.toMatch(/<link[^>]+stylesheet/i)
    expect(html).toMatch(/<style>/)
    expect(html).toMatch(/<script>/)
  })

  test('has no unreplaced build placeholders', () => {
    expect(html).not.toMatch(/<!--(STYLES|SCRIPT)-->/)
  })

  test('carries no dependency on the PropsKit component library', () => {
    // The original UI was built from fig-* elements, which only exist inside
    // Figma's generative-plugin runtime.
    expect(html).not.toMatch(/<fig-/)
  })
})

describe('minified output integrity', () => {
  const html = read('dist/ui.html')
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? ''

  test('the inlined script is syntactically valid', () => {
    // The original UI shipped broken because nothing checked this.
    expect(script.length).toBeGreaterThan(0)
    expect(() => new Function(script)).not.toThrow()
  })

  test('string literals survive HTML minification intact', () => {
    // Markup is minified before inlining precisely so the whitespace-collapse
    // and `>\s+<` rewrites cannot reach into JS or CSS string literals.
    for (const literal of [
      'Fill feature and flow for every frame',
      'cannot be auto-named',
      'Something went wrong',
    ]) {
      expect(script).toContain(literal)
    }
  })

  test('the stylesheet is inlined and non-trivial', () => {
    const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? ''
    expect(style.length).toBeGreaterThan(100)
    expect(style).toContain('--figma-color-bg')
  })
})

describe('dist/code.js', () => {
  const code = read('dist/code.js')

  test('has the build-time version substituted in', () => {
    expect(code).toContain(pkg.version)
    expect(code).not.toContain('__PLUGIN_VERSION__')
  })

  test('is bundled — no module syntax left for Figma to choke on', () => {
    expect(code).not.toMatch(/^\s*import\s/m)
    expect(code).not.toMatch(/^\s*export\s/m)
    expect(code).not.toMatch(/\brequire\(/)
  })
})
