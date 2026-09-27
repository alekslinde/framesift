# FrameSift

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
choose `manifest.json` at the repo root.

`npm run watch` rebuilds on change — TypeScript, the UI markup and stylesheet —
so you only need to re-run the plugin in Figma.

Plugin development needs the Figma **desktop app**; the browser version cannot
load a local manifest. [CONTRIBUTING.md](CONTRIBUTING.md) has the fuller setup.

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

`npm run build` writes the two bundles to `dist/`:

| File       | Notes                                                              |
| ---------- | ------------------------------------------------------------------ |
| `code.js`  | Bundled and minified plugin backend.                               |
| `ui.html`  | Panel with CSS and JS inlined — Figma allows no external requests. |

`manifest.json` stays at the repo root and is committed; the build only checks
that its `main`/`ui` still point at those two files. `dist/` is not committed —
build before importing or publishing.

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

- **feature** — what the screen belongs to, e.g. `checkout`.
- **viewport** — one of `watch`, `mobile`, `mobile-ls`, `tablet`, `tablet-ls`,
  `desktop`. Inferred from the frame's longest edge and orientation.
- **flow** — the user flow the screens belong to, e.g. `guest-checkout`.
  Defaults to the frame's largest text.

Each part can be set for every frame at once, or per frame. The intended
workflow is to select the frames of **one user flow**, set feature and flow
once, and rename — the per-frame cards start collapsed and exist for the
exceptions.

Setting a value on an individual frame opts that frame out of the matching
"apply to all" value; every other frame keeps following it. Clearing an
"apply to all" field returns each frame to its own value — for viewport, that is
the one inferred from its dimensions.

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

The version is compiled into the plugin bundle and shown in the panel's footer,
so the build running in Figma is identifiable.

## Publishing

`manifest.json` declares `networkAccess: none`, which is accurate — the plugin
reads and renames layers in the open file and makes no network requests.

Run `npm run check` before publishing, so `dist/` matches the source.

The plugin `id` is issued by Figma and must not be edited by hand — the build
rejects anything that is not a Figma-format id.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, the
conventions that are load-bearing here, and what to verify before opening a
pull request.

## License

Apache-2.0. See [LICENSE](LICENSE).
