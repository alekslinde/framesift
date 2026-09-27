/**
 * Guards the shape of dist/ — the artifact that actually gets imported into
 * Figma. Requires a build first; `npm test` runs one via pretest.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const root = resolve(__dirname, '..')
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8')

const manifest = JSON.parse(read('manifest.json'))
const pkg = JSON.parse(read('package.json'))

describe('manifest.json', () => {
  test('points at the files the build emits', () => {
    // Figma resolves these relative to the manifest, which lives at the root.
    expect(manifest.main).toBe('dist/code.js')
    expect(manifest.ui).toBe('dist/ui.html')
    expect(() => read(manifest.main)).not.toThrow()
    expect(() => read(manifest.ui)).not.toThrow()
  })

  test('carries no property Figma does not recognise', () => {
    // Figma validates against a closed schema and refuses the import outright
    // on an unknown key — a `version` field here is what broke it before.
    const ALLOWED = new Set([
      'name',
      'id',
      'api',
      'main',
      'ui',
      'editorType',
      'documentAccess',
      'networkAccess',
      'menu',
      'parameters',
      'parameterOnly',
      'enableProposedApi',
      'enablePrivatePluginApi',
      'build',
      'permissions',
      'relaunchButtons',
      'capabilities',
      'codegenLanguages',
      'codegenPreferences',
      'widgetApi',
    ])
    const unexpected = Object.keys(manifest).filter((key) => !ALLOWED.has(key))
    expect(unexpected).toEqual([])
  })

  test('declares no network access, matching what the plugin does', () => {
    expect(manifest.networkAccess.allowedDomains).toEqual(['none'])
  })

  test('has a Figma-issued plugin id', () => {
    // Figma assigns a numeric id when a plugin is created or published; it does
    // not fill one in on manifest import. A UUID here means the id came from
    // somewhere else and the plugin will not publish under it.
    expect(manifest.id).toMatch(/^\d{15,25}$/)
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
