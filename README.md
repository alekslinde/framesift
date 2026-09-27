# Renamely

A Figma plugin that renames frames and their child layers to a consistent
convention, in two steps:

1. **Rename layers** — walks each selected frame up to three levels deep and
   renames child layers to semantic slot names (`_label`, `_cta`, `_bg`, …)
   inferred from node type, text content, image fills, and existing names.
2. **Rename frames** — builds `feature_viewport_flow` names for the selected
   frames, with a per-frame preview and automatic numbering when two frames
   would end up with the same name.

Components, component sets, instances, and locked layers are never modified.

## Install for development

```bash
npm install
npm run build
```

Then in Figma: **Plugins → Development → Import plugin from manifest…** and
choose `dist/manifest.json`.

`npm run watch` rebuilds everything on change — TypeScript, the UI markup and
stylesheet, and the manifest — so you only need to re-run the plugin in Figma.

## Layout

```
src/
  classify.ts     layer → slot-name classification
  naming.ts       slug sanitising, frame-name assembly, collision resolution
  traverse.ts     which layers get renamed, and how deep
  viewport.ts     frame dimensions → viewport label
  code.ts         plugin backend: messaging and apply
  ui/             panel markup, styles, and logic
scripts/
  build.mjs       bundles, minifies, and emits dist/
  version.mjs     version bump + tag
test/             unit tests, plus jsdom tests that drive the built UI
```

The pure modules (`classify`, `naming`, `traverse`, `viewport`) hold the logic
worth testing and have no dependency on the Figma API, so they run under plain
Node. `traverse` is typed structurally, so tests supply plain objects in place of
Figma nodes.

Both the previewed layer count and the rename itself go through
`walkRenamable`, sharing one visited-set, so the number the panel promises cannot
drift from what actually gets renamed.

## Build

`npm run build` writes a complete, importable plugin to `dist/`:

| File            | Notes                                                      |
| --------------- | ---------------------------------------------------------- |
| `code.js`       | Bundled and minified plugin backend.                       |
| `ui.html`       | Panel with CSS and JS inlined — Figma allows no external requests. |
| `manifest.json` | Generated from the root manifest, with `main`/`ui` rewritten to sit beside it and the `package.json` version carried through. |

The root `manifest.json` is the only hand-maintained copy; the build derives the
`dist/` one so the two cannot drift. `dist/` is not committed — build before
importing or publishing.

`npm run build:dev` skips minification and adds inline sourcemaps, which is what
`npm run watch` uses.

## Checks

```bash
npm run check      # typecheck + production build + tests
npm test           # tests only (builds first)
npm run typecheck
```

`test/ui.test.ts` loads the built `dist/ui.html` in jsdom and drives it the way
Figma would, so it covers the panel's wiring — name previews, global overrides,
focus retention while typing, and error reporting — rather than just the pure
functions. It runs against the **minified production** bundle, so a build that
breaks under minification fails the suite. `test/build.test.ts` guards the shape
of `dist/` itself.

## Naming rules

A frame name is `feature_viewport_flow`:

- **feature** — what the screen belongs to, e.g. `checkout`. Set per frame or
  for all frames at once.
- **viewport** — one of `watch`, `mobile`, `mobile-ls`, `tablet`, `tablet-ls`,
  `desktop`. Inferred from the frame's longest edge and orientation; override
  per frame or globally.
- **flow** — the specific screen, defaulting to the frame's largest text.

All three parts are required; the Rename button stays disabled until every
selected frame has them. Names are lowercased and reduced to `a–z`, `0–9`, `-`
and `_`. Accented Latin characters are folded (`Über Café` → `uber-cafe`). Text
in a script that has no ASCII equivalent is **not** transliterated or silently
dropped — the frame is flagged so you can type a name yourself.

Layer renaming is idempotent: generated names carry a leading `_`, and a second
pass leaves them untouched rather than reclassifying its own output.

## Releasing

Bump the version, which commits `package.json` and creates an annotated tag:

```bash
npm run version:patch    # 0.1.0 → 0.1.1
npm run version:minor    # 0.1.0 → 0.2.0
npm run version:major    # 0.1.0 → 1.0.0
```

For an exact version, or to preview without changing anything:

```bash
node scripts/version.mjs 1.4.2
node scripts/version.mjs patch --dry-run
```

The bump refuses to run on a dirty tree, so a tag always points at a known
state. Then:

```bash
npm run check                  # typecheck, build, test
git push --follow-tags
```

The version appears in `dist/manifest.json` and in the panel's footer, so the
build in Figma is identifiable.

## Publishing

`manifest.json` declares `networkAccess: none`, which is accurate — the plugin
reads and renames layers in the open file and makes no network requests.

Publish from `dist/` after `npm run check`. Note that the plugin `id` in the
manifest is carried over from earlier development; Figma issues an id when you
create the Community plugin, and that one needs to replace it.

## License

Apache-2.0. See [LICENSE](LICENSE).
