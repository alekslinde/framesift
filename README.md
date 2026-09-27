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
choose `manifest.json`.

`npm run watch` rebuilds the plugin backend on change. The UI is bundled
separately — rerun `npm run build:ui` after editing anything in `src/ui/`.

## Layout

```
src/
  classify.ts   layer → slot-name classification
  naming.ts     slug sanitising, frame-name assembly, collision resolution
  viewport.ts   frame dimensions → viewport label
  code.ts       plugin backend: messaging, traversal, apply
  ui/           panel markup, styles, and logic
scripts/
  build-ui.mjs  inlines CSS + JS into the single HTML file Figma requires
test/           unit tests, plus a jsdom test that drives the built UI
```

The pure modules (`classify`, `naming`, `viewport`) hold the logic worth testing
and have no dependency on the Figma API, so they run under plain Node.

## Checks

```bash
npm run check      # typecheck + build + test
npm test           # tests only (rebuilds the UI first)
npm run typecheck
```

`test/ui.test.ts` loads `dist/ui.html` in jsdom and drives it the way Figma
would, so it covers the panel's wiring — name previews, global overrides, focus
retention while typing, and error reporting — rather than just the pure
functions.

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

## Publishing

`manifest.json` declares `networkAccess: none`, which is accurate — the plugin
reads and renames layers in the open file and makes no network requests.

Build before publishing, since `dist/` is not committed:

```bash
npm run check
```

## License

Apache-2.0. See [LICENSE](LICENSE).
