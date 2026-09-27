# FrameSift — Claude Config

> Inherits global values from ~/.claude/CLAUDE.md

---

## Project Context

**Stack:** Figma plugin (plugin API 1.0.0), esbuild, vitest + jsdom
**Package manager:** npm
**Primary language:** TypeScript

No framework, no runtime dependencies. Everything in `devDependencies` is build
or test tooling, and the shipped plugin bundles nothing but our own code.

**Two execution contexts.** A Figma plugin runs in two sandboxes that share no
memory and talk only by message passing:

- `src/code.ts` — the plugin backend. Has `figma.*` and the document; no DOM.
- `src/ui/` — the panel, a normal iframe document. Has the DOM; no `figma.*`.

Nothing crosses that line except JSON-serialisable messages, and the boundary is
**not** enforced by the compiler — both contexts share one tsconfig, so `figma.*`
in UI code typechecks happily and then fails at runtime in Figma. Keep the split
by discipline: `figma.*` only in `code.ts`, `document`/`window` only under
`src/ui/`.

---

## Project Structure

```
src/
  classify.ts     ← layer → slot-name classification
  naming.ts       ← slug sanitising, frame-name assembly, collision resolution
  traverse.ts     ← which layers get renamed, and how deep
  viewport.ts     ← frame dimensions → viewport label
  code.ts         ← plugin backend: messaging and apply
  ui/             ← panel: ui.html, ui.css, ui.ts
scripts/
  build.mjs       ← bundles, minifies, emits dist/
  version.mjs     ← version bump + tag
test/             ← unit tests, plus jsdom tests driving the built UI
dist/             ← build output, gitignored, what Figma imports
```

The four pure modules hold the logic worth testing and never touch `figma.*`, so
they run under plain Node. New logic belongs in one of them, not in `code.ts` or
`ui.ts` — those two are wiring.

`traverse.ts` is typed structurally (`TraversableNode`), so tests pass plain
objects instead of mocking the plugin API. Keep it that way.

---

## Code Reuse

- Check the four pure modules before writing new logic — most naming, matching,
  and traversal questions already have a home
- Extend an existing module rather than adding a parallel one
- Extract logic used in 2+ places; inline logic stays inline until it recurs
- `code.ts` and `ui/ui.ts` are wiring: message handling, DOM updates, and
  Figma API calls. Business logic there is a smell — move it to a pure module
  where it can be tested

---

## Conventions

**Layer classification is token-equality, never substring.** `slotFromName`
matches whole word tokens, longest keyword first. This is deliberate and load
bearing: `"rectangle"` contains `"cta"`, so substring matching renames every
default Figma rectangle to a call-to-action. Do not add a substring or
`includes()` fallback to the matcher — it has been tried and it reintroduces
exactly that bug. Run-together names like `navitem` correctly fall through to the
node-type slot rather than being guessed at.

**One traversal, shared visited-set.** Both the previewed layer count and the
rename itself go through `walkRenamable` with a shared `seen` set, so the number
the panel promises cannot drift from what gets renamed. Protected nodes
(components, component sets, instances, locked) are filtered *inside* the walk,
for roots and children alike — never in a caller. A caller-side guard is how the
two passes previously disagreed, and how component internals got renamed.

**Renaming is idempotent.** Generated layer names carry a leading `_`, and
`classify` returns them unchanged so a second pass cannot reclassify its own
output.

**Nothing silently mangles a name.** Accented Latin folds (`Über Café` →
`uber-cafe`). Text in a script with no ASCII equivalent is flagged for manual
naming, not transliterated by guess or replaced with a placeholder. If a name
cannot be produced honestly, the UI says so and the button stays disabled.

**The UI reconciles, never rebuilds.** Cards are created once and updated in
place. Do not reach for `innerHTML` on the frame list: it destroys the input the
user is typing in. `setIfNotFocused` exists for this reason — respect it.

**Globals are a display layer and are never written into per-frame state.** The
"Apply to all frames" values sit *over* each frame's own, and `overridden` records
which frames the user set explicitly so a global skips them. Committing a global
into every frame — which an earlier version did when one frame was edited —
destroys the inferred viewports, and "Per frame" then has nothing to restore:
every frame reads back as whatever the global was. A frame's own value must
always be either what the user typed for it or what the plugin inferred.

**Empty is not unset.** A global of `""` means "not set", so per-frame values
apply again. Treating empty as falsy is how "Per frame" became a silent no-op.

**Errors surface.** The UI disables buttons optimistically when it posts, so
every backend failure must report back or a step wedges permanently. Per-node
failures are counted and shown with a reason, never swallowed.

**Panel styling uses Figma's theme variables** (`--figma-color-*`, enabled by
`themeColors: true`), each with a fallback. Do not hardcode colours; the panel
follows the editor's light/dark setting.

---

## Git Scopes

Use these scopes in commit messages:

- `(plugin)` — backend: messaging, traversal, apply
- `(ui)` — panel markup, styles, and logic
- `(naming)` — classification, sanitising, collision resolution
- `(build)` — build scripts and bundling
- `(release)` — version bumps and tags
- `(config)` — manifest, tsconfig, CI

---

## Off Limits

- **Don't hand-edit `dist/`** — it is generated and gitignored. Change `src/` or
  `scripts/build.mjs` instead.
- **Don't generate or copy `manifest.json`.** It is a committed file at the repo
  root and Figma imports it directly; `scripts/build.mjs` only checks that its
  `main`/`ui` still point at what the build emits. Generating a second copy into
  `dist/` was tried and removed — it bought nothing and added a failure mode.
- **Don't add properties to the manifest.** Figma validates it against a closed
  schema and refuses the import on any key it does not recognise — a `version`
  field broke exactly this. Build metadata belongs in the bundle via `define`
  (see `__PLUGIN_VERSION__`), not the manifest. `test/build.test.ts` enforces it.
- **Don't commit `node_modules/` or `dist/`.**
- **Don't add runtime dependencies** without a reason that survives scrutiny. A
  Figma plugin UI cannot fetch anything at runtime — every dependency is inlined
  into the bundle Figma loads.

---

## Commands to Know

```bash
npm run build       ← production build (minified) → dist/
npm run build:dev   ← unminified, inline sourcemaps
npm run watch       ← rebuild on change (dev mode)
npm run check       ← typecheck, then test; run before committing
npm test            ← builds first (pretest), then tests
npm run typecheck   ← tsconfig.json (src) and tsconfig.test.json (tests)
```

`tsconfig.test.json` exists because test files need Node and jsdom types that
plugin source should not see. It is a src/test split, not a backend/UI one.

There is no lint script. `npm run check` is the gate.

Load the plugin in Figma via **Plugins → Development → Import plugin from
manifest…** and choose `manifest.json` at the repo root. Build first — it points
into `dist/`, which is gitignored.

---

## Testing

`npm run check` runs the tests against the **minified production** bundle, so a
change that only breaks under minification fails the suite.

`test/ui.test.ts` loads the built `dist/ui.html` in jsdom and drives it the way
Figma would — it covers panel wiring that unit tests cannot reach. It fails
loudly if `dist/` is older than `src/`, because running `vitest` directly skips
the pretest build and would otherwise report stale failures.

`test/build.test.ts` guards the shipped artifacts: the manifest's paths and key
set, no external asset references in the panel, valid minified script, no
leftover placeholders.

When fixing a bug, verify the new test actually catches it — revert the fix and
confirm the test fails. Several tests here exist because that check caught a
"fix" that didn't work.

---

## Notes

**Origin.** This started as a Figma *generative* plugin: its UI was built from
PropsKit `fig-*` custom elements, which only exist inside Figma's agent runtime
and cannot ship to the Community. Both layers were rewritten. If you see a
`fig-*` element anywhere, it is a regression — `test/build.test.ts` checks for
this.

**The plugin `id` is Figma-issued and must not be hand-edited.** Figma assigns it
when a plugin is created (Plugins → Development → New plugin…) or at publish
time — never on manifest import, which only reads what is already in the file. It
is an ~18-digit numeric string; a UUID means it came from somewhere that is not
Figma. `scripts/build.mjs` rejects anything else.

**Not yet verified in Figma.** Every check in this repo is automated. The API
surface the backend touches — `getNodeByIdAsync`, `documentAccess:
dynamic-page`, `themeColors` — has not been exercised in the real editor. Try a
scratch file before trusting it on real work.

**`networkAccess` is declared `none`**, which is accurate: the plugin reads and
renames layers in the open file and makes no requests. Keep it that way, or the
manifest becomes a false claim.
