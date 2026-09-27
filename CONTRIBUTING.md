# Contributing to FrameSift

Thanks for helping out. This guide covers what you need to work on the plugin
and the few conventions that are load-bearing here.

## Getting set up

You need Node 22 (the version CI uses) and a Figma desktop app — the browser
version cannot load a plugin from a local manifest.

```bash
git clone <this repo>
cd framesift
npm install
npm run build
```

Then in Figma: **Plugins → Development → Import plugin from manifest…** and
choose `manifest.json` at the repo root. It stays imported, so you only do this
once.

While working, `npm run watch` rebuilds on every change. Figma does not hot
reload, so re-run the plugin from **Plugins → Development → FrameSift** to pick
up a change.

## The shape of the project

A Figma plugin runs in two sandboxes that share no memory and communicate only
by message passing:

- **`src/code.ts`** — the backend. Has the Figma API and the document; no DOM.
- **`src/ui/`** — the panel, an ordinary iframe document. Has the DOM; no Figma
  API.

Nothing crosses that line except JSON-serialisable messages. **The compiler does
not enforce this** — both share one tsconfig, so `figma.*` in UI code compiles
happily and then fails at runtime. Keep the split by hand.

The logic lives in four modules with no Figma dependency, which is what makes it
testable under plain Node:

| Module | Responsibility |
| --- | --- |
| `classify.ts` | What a layer should be called, from its type, name, and contents |
| `naming.ts` | Slug sanitising, frame-name assembly, collision resolution |
| `traverse.ts` | Which layers get renamed, and how deep |
| `viewport.ts` | Frame dimensions → viewport label |

`code.ts` and `src/ui/ui.ts` are wiring: messages, DOM updates, Figma calls. New
logic belongs in a pure module where it can be tested, not in either of those.

## Checks

```bash
npm run check      # typecheck, build, and test — run this before pushing
npm test           # tests only (builds first)
npm run typecheck
```

CI runs `npm run check` on every pull request. There is no linter; the type
checker and tests are the gate.

## Testing

Tests run against the **minified production bundle**, so a change that only
breaks under minification fails the suite.

- Pure-logic tests (`classify`, `naming`, `traverse`, `viewport`) are plain unit
  tests. `traverse` is typed structurally, so pass plain objects rather than
  mocking the plugin API.
- `ui.test.ts` loads the built `dist/ui.html` in jsdom and drives it the way
  Figma does. This is where panel wiring is covered.
- `build.test.ts` guards the shipped artifacts: manifest keys and paths, no
  external asset references, valid minified script.

**When you fix a bug, check that your test catches it.** Revert the fix, confirm
the test fails, then restore it. Several tests here exist because that step
caught a "fix" that did not work, or a test that asserted the wrong thing.

Two things the suite cannot check, so check them yourself:

- **Layout.** jsdom performs no layout and reports every box as zero. Anything
  about sizing or position has to be looked at in the editor.
- **The Figma API.** Nothing in CI calls it. If you touch `code.ts`, run the
  plugin.

## Conventions worth knowing

These are the ones where the obvious change is the wrong one.

**Layer classification matches whole tokens, never substrings.** `"rectangle"`
contains `"cta"`, so substring matching renames every default Figma rectangle to
a call-to-action. Do not add an `includes()` fallback — it has been tried, and it
brings that bug straight back. Run-together names like `navitem` correctly fall
through to the node-type slot instead of being guessed at.

**Counting and renaming share one traversal.** Both go through `walkRenamable`
with a shared visited-set, so the count the panel promises cannot drift from what
gets renamed. Protected nodes — components, component sets, instances, locked —
are filtered *inside* the walk, for roots and children alike. A caller-side guard
is how the two passes previously disagreed, and how component internals got
renamed.

**Renaming is idempotent.** Generated names carry a leading `_`, and `classify`
returns them unchanged, so a second pass cannot reclassify its own output.

**Globals are a display layer.** The "apply to all frames" values sit over each
frame's own and are never written into per-frame state. Committing them destroys
the inferred viewports, and "Per frame" then has nothing to restore.

**Empty is not unset.** A global of `""` means "not set", so per-frame values
apply again. Treating empty as falsy is how "Per frame" became a silent no-op.

**The UI reconciles, never rebuilds.** Cards are created once and updated in
place. Do not reach for `innerHTML` on the frame list — it destroys the input the
user is typing in.

**Errors surface.** The UI disables buttons optimistically when it posts, so any
backend failure must report back or the step wedges permanently.

**User-facing copy is pinned by tests.** The step 1 explainer and the empty
state's example are checked against the real classifier and name format, so the
panel cannot end up describing behaviour the code does not have. If you change
either, update the other.

**Do not add properties to `manifest.json`.** Figma validates against a closed
schema and refuses the import on any key it does not recognise. Build metadata
goes in the bundle via `define` — see `__PLUGIN_VERSION__`.

## Commits and pull requests

Commit messages follow `type(scope): summary`, under about 50 characters:

```
feat(ui): collapse frame cards
fix(build): drop the version field Figma rejects
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `build`, `style`,
`perf`. Scopes in use: `plugin`, `ui`, `naming`, `build`, `release`, `config`.

Explain *why* in the body when it is not obvious from the diff — particularly
for a fix, where the failure being prevented is the useful part.

Work on a branch named `<type>/<short-description>`, and open a pull request
rather than pushing to `main`. The PR template asks what you verified in Figma;
please fill that in, since it is the part CI cannot do.

## Releasing

Maintainers only:

```bash
npm run version:patch   # or :minor / :major
npm run check
git push --follow-tags
```

The bump refuses to run on a dirty tree, so the tag always points at a known
state. `dist/` is not committed — build before publishing.

## Reporting a bug

Include the Figma version, what you selected, what you expected, and what you
got. For a renaming bug, the layer names before and after are the most useful
thing you can attach — the classifier's behaviour depends on them directly.
