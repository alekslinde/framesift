// Figma loads the plugin UI as one self-contained HTML document: no external
// script or stylesheet requests are possible. This bundles src/ui/ui.ts and
// inlines it, along with ui.css, into dist/ui.html.
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = (p) => resolve(root, 'src/ui', p)

const [{ outputFiles }, html, css] = await Promise.all([
  build({
    entryPoints: [src('ui.ts')],
    bundle: true,
    format: 'iife',
    target: 'es2017',
    write: false,
    minify: false,
  }),
  readFile(src('ui.html'), 'utf8'),
  readFile(src('ui.css'), 'utf8'),
])

const script = outputFiles[0].text

if (!html.includes('<!--STYLES-->') || !html.includes('<!--SCRIPT-->')) {
  throw new Error('src/ui/ui.html must contain <!--STYLES--> and <!--SCRIPT--> placeholders')
}

// Inserted verbatim into the document, so a literal </script> in the bundle
// would close the tag early. No such sequence should exist, but guard anyway.
const safeScript = script.replace(/<\/script>/gi, '<\\/script>')

const out = html
  .replace('<!--STYLES-->', `<style>\n${css}\n</style>`)
  .replace('<!--SCRIPT-->', `<script>\n${safeScript}\n</script>`)

await mkdir(resolve(root, 'dist'), { recursive: true })
await writeFile(resolve(root, 'dist/ui.html'), out, 'utf8')

console.log(`dist/ui.html  ${(Buffer.byteLength(out) / 1024).toFixed(1)} kB`)
