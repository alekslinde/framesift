/**
 * Bumps the version in package.json, tags the commit, and leaves the tree ready
 * to push. dist/ is generated, so nothing there is version-controlled — the tag
 * plus package.json is the record.
 *
 * Usage: node scripts/version.mjs <major|minor|patch|x.y.z> [--dry-run]
 *
 * Refuses to run on a dirty tree, so the tag always points at a known state.
 */
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const p = (...parts) => resolve(root, ...parts)

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

function nextVersion(current, bump) {
  if (SEMVER.test(bump)) return bump

  const match = SEMVER.exec(current)
  if (!match) fail(`current version "${current}" is not semver`)
  const [major, minor, patch] = match.slice(1).map(Number)

  switch (bump) {
    case 'major':
      return `${major + 1}.0.0`
    case 'minor':
      return `${major}.${minor + 1}.0`
    case 'patch':
      return `${major}.${minor}.${patch + 1}`
    default:
      return fail(`expected major, minor, patch, or an explicit x.y.z — got "${bump}"`)
  }
}

async function git(...args) {
  const { stdout } = await run('git', args, { cwd: root })
  return stdout.trim()
}

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const bump = args.find((a) => !a.startsWith('--'))

if (!bump) {
  fail('usage: node scripts/version.mjs <major|minor|patch|x.y.z> [--dry-run]')
}

const pkgPath = p('package.json')
const pkgText = await readFile(pkgPath, 'utf8')
const pkg = JSON.parse(pkgText)
const from = pkg.version
const to = nextVersion(from, bump)

if (from === to) fail(`already at ${to}`)

const status = await git('status', '--porcelain')
if (status && !dryRun) {
  fail('working tree is not clean — commit or stash first, so the tag points at a known state')
}

const tag = `v${to}`
const existing = await git('tag', '--list', tag)
if (existing) fail(`tag ${tag} already exists`)

if (dryRun) {
  console.log(`${from} → ${to}  (dry run; would commit package.json and tag ${tag})`)
  process.exit(0)
}

// Rewrite only the version line, preserving the file's existing formatting.
const updated = pkgText.replace(
  /("version"\s*:\s*")[^"]+(")/,
  (_, before, after) => `${before}${to}${after}`,
)
if (updated === pkgText) fail('could not find a version field to update in package.json')

// Read and rewrite the lockfile before touching package.json, so a failure
// leaves nothing half-applied. Only files that actually changed get staged —
// staging a path that does not exist would abort after the rewrite, leaving a
// dirty tree with no commit and a clean-tree check blocking the retry.
const lockPath = p('package-lock.json')
let lockOut = null
try {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'))
  lock.version = to
  if (lock.packages?.['']) lock.packages[''].version = to
  lockOut = `${JSON.stringify(lock, null, 2)}\n`
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

const staged = ['package.json']
await writeFile(pkgPath, updated, 'utf8')
if (lockOut !== null) {
  await writeFile(lockPath, lockOut, 'utf8')
  staged.push('package-lock.json')
}

await git('add', ...staged)
await git('commit', '-m', `chore(release): ${to}`)
await git('tag', '-a', tag, '-m', tag)

console.log(`${from} → ${to}`)
console.log(`committed and tagged ${tag}`)
console.log(`\nnext: npm run build && git push --follow-tags`)
