/**
 * Builds the plugin into dist/.
 *
 * Figma loads a plugin UI as one self-contained HTML document — no external
 * script or stylesheet requests are possible — so the UI bundle and stylesheet
 * are inlined into a single file.
 *
 * dist/ is a complete, importable plugin: manifest.json is emitted alongside
 * code.js and ui.html with its paths rewritten, so `main`/`ui` resolve next to
 * the manifest rather than through a dist/ prefix. The root manifest stays the
 * only hand-maintained copy.
 *
 * Usage: node scripts/build.mjs [--dev] [--watch]
 *   --dev    skip minification, keep sourcemaps (implied by --watch)
 *   --watch  rebuild on change
 */
import { context as esbuildContext, build as esbuildBuild } from 'esbuild'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = resolve(root, 'dist')
const p = (...parts) => resolve(root, ...parts)

const args = new Set(process.argv.slice(2))
const watch = args.has('--watch')
const dev = args.has('--dev') || watch
const minify = !dev

const pkg = JSON.parse(await readFile(p('package.json'), 'utf8'))

/** Shared esbuild options. `define` lets the source reference the version. */
const common = {
  bundle: true,
  target: 'es2017',
  format: 'iife',
  minify,
  sourcemap: dev ? 'inline' : false,
  legalComments: 'none',
  define: {
    __PLUGIN_VERSION__: JSON.stringify(pkg.version),
  },
}

async function buildCode() {
  const result = await esbuildBuild({
    ...common,
    entryPoints: [p('src/code.ts')],
    outfile: p('dist/code.js'),
    write: true,
    metafile: true,
  })
  const output = Object.values(result.metafile.outputs)[0]
  return output ? output.bytes : 0
}

async function buildUI() {
  const [bundle, html, css] = await Promise.all([
    esbuildBuild({
      ...common,
      entryPoints: [p('src/ui/ui.ts')],
      write: false,
    }),
    readFile(p('src/ui/ui.html'), 'utf8'),
    readFile(p('src/ui/ui.css'), 'utf8'),
  ])

  if (!html.includes('<!--STYLES-->') || !html.includes('<!--SCRIPT-->')) {
    throw new Error('src/ui/ui.html must contain <!--STYLES--> and <!--SCRIPT--> placeholders')
  }

  const script = bundle.outputFiles[0].text
  // Inserted verbatim into the document, so a literal </script> anywhere in the
  // bundle would close the tag early. None should exist, but guard regardless.
  const safeScript = script.replace(/<\/script>/gi, '<\\/script>')
  const style = minify ? minifyCss(css) : css

  // Markup is minified BEFORE the script and stylesheet are inlined, so those
  // regexes only ever see hand-written HTML. Running them over the finished
  // document would let a `> <` or a double space inside a JS or CSS string
  // literal be rewritten, corrupting the bundle.
  const shell = minify ? minifyHtml(html) : html
  const pad = minify ? '' : '\n'

  const out = shell
    .replace('<!--STYLES-->', `<style>${pad}${style}${pad}</style>`)
    .replace('<!--SCRIPT-->', `<script>${pad}${safeScript}${pad}</script>`)

  await writeFile(p('dist/ui.html'), out, 'utf8')
  return Buffer.byteLength(out)
}

/**
 * Emits dist/manifest.json from the root manifest, with main/ui rewritten to
 * sit beside it and the package version carried through.
 */
async function buildManifest() {
  const manifest = JSON.parse(await readFile(p('manifest.json'), 'utf8'))

  for (const [key, expected] of [['main', 'dist/code.js'], ['ui', 'dist/ui.html']]) {
    if (manifest[key] !== expected) {
      throw new Error(`manifest.json "${key}" should be "${expected}", found "${manifest[key]}"`)
    }
  }

  const out = {
    ...manifest,
    main: 'code.js',
    ui: 'ui.html',
    // Figma shows this on the plugin's page; keep it in step with package.json.
    version: pkg.version,
  }

  const text = `${JSON.stringify(out, null, 2)}\n`
  await writeFile(p('dist/manifest.json'), text, 'utf8')
  return Buffer.byteLength(text)
}

/**
 * Conservative CSS minification: strips comments and collapses whitespace.
 * Enough for one hand-written stylesheet, with no parser to get wrong.
 */
function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}:;,>])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim()
}

/**
 * Collapses inter-tag whitespace and drops comments from the markup shell. Runs
 * before the script and stylesheet are inlined, so it never sees their content —
 * the build's placeholder comments are therefore preserved, and everything else
 * is hand-written HTML where these rewrites are safe.
 */
function minifyHtml(html) {
  return html
    .replace(/<!--(?!(?:STYLES|SCRIPT)-->)[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`

async function buildAll() {
  await rm(dist, { recursive: true, force: true })
  await mkdir(dist, { recursive: true })
  const [code, ui, manifest] = await Promise.all([buildCode(), buildUI(), buildManifest()])
  const mode = minify ? 'production' : 'development'
  console.log(
    `dist/ (${mode}, v${pkg.version})\n` +
      `  code.js        ${kb(code)}\n` +
      `  ui.html        ${kb(ui)}\n` +
      `  manifest.json  ${kb(manifest)}`,
  )
}

if (watch) {
  // Coalesces bursts into one build: editors and esbuild can both signal for a
  // single save, and macOS emits several fs events per write. A signal arriving
  // mid-build queues one more pass rather than being dropped, so no edit is
  // missed.
  let timer = null
  let running = false
  let queued = false

  const runBuild = async () => {
    running = true
    try {
      await buildAll()
    } catch (error) {
      console.error(error instanceof Error ? error.message : error)
    } finally {
      running = false
      if (queued) {
        queued = false
        await runBuild()
      }
    }
  }

  const rebuild = () => {
    if (running) {
      queued = true
      return
    }
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void runBuild()
    }, 120)
  }

  /**
   * macOS emits a second fs event for a single write, sometimes more than a
   * second later — too far apart for any debounce. So the plain-file watchers
   * compare content hashes and only rebuild when something really changed.
   */
  const { createHash } = await import('node:crypto')
  const hashes = new Map()
  const changed = async (file) => {
    let digest
    try {
      digest = createHash('sha1').update(await readFile(p(file))).digest('hex')
    } catch {
      return true // unreadable mid-write; let the build report it
    }
    if (hashes.get(file) === digest) return false
    hashes.set(file, digest)
    return true
  }

  // esbuild here is only a change detector for the TypeScript import graph; its
  // onEnd also covers the first build, so nothing is built twice at startup.
  // outdir stays outside dist/ and write is off, otherwise the watcher would
  // observe buildAll()'s own output and loop.
  const ctx = await esbuildContext({
    ...common,
    entryPoints: [p('src/ui/ui.ts'), p('src/code.ts')],
    outdir: p('node_modules/.tmp/watch'),
    write: false,
    plugins: [
      {
        name: 'rebuild-all',
        setup(build) {
          build.onEnd(rebuild)
        },
      },
    ],
  })
  await ctx.watch()

  // The HTML, CSS and manifest are not in that graph, so watch them directly.
  const { watch: fsWatch } = await import('node:fs')
  const plainFiles = ['src/ui/ui.html', 'src/ui/ui.css', 'manifest.json', 'package.json']
  for (const file of plainFiles) {
    await changed(file) // seed the hash so startup does not count as a change
    fsWatch(p(file), { persistent: true }, () => {
      changed(file).then((real) => {
        if (real) rebuild()
      })
    })
  }

  console.log('watching for changes…')
} else {
  await buildAll()
}
