# vite-plugin-haze-ui

Vite plugin for [haze-ui](https://www.npmjs.com/package/haze-ui) that injects per-component CSS automatically, based on your named imports.

```ts
// 你只写这一行：
import {Button, OTPInput, Title} from 'haze-ui';
// 插件在构建期自动把该模块变为：
import 'haze-ui/css/tokens.css';
import 'haze-ui/css/button.css';
import 'haze-ui/css/otp-input.css';
import 'haze-ui/css/typography.css';
import {Button, OTPInput, Title} from 'haze-ui';
```

## Motivation

haze-ui ships one CSS file per component family under `haze-ui/css/*`. Before this plugin, consumers had to hand-maintain a parallel import list — every component you used needed a matching `import 'haze-ui/css/<name>.css'`, which drifts constantly (forget one and the component renders unstyled; delete a component and the css lingers).

`vite-plugin-haze-ui` closes the loop at build time: it scans each module's `import {…} from 'haze-ui'` statements during Vite's `transform` phase and prepends the mapped side-effect imports. Deduplication, code-splitting (a lazy-loaded route only carries the css of the components it uses) and HMR are all handled by Vite/Rollup's native module graph — the plugin itself keeps zero build state.

## Usage

```bash
pnpm add -D vite-plugin-haze-ui
```

```ts
// vite.config.ts
import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import hazeCss from 'vite-plugin-haze-ui';

export default defineConfig({
  plugins: [
    // Must run before React/esbuild transforms strip the TS syntax.
    // The plugin sets `enforce: 'pre'` itself, so the position in the
    // array is not load-bearing — put it wherever reads best.
    hazeCss(),
    react()
  ]
});
```

Notes:

- Import the full component styles manually is no longer needed anywhere; remove your old `haze-ui/styles.css` / per-component css import list.
- `tokens.css` is always injected first for every consuming module — theme variables, spacing and typographic baselines all live there. Rollup dedupes it to the earliest module in the graph (your entry), guaranteeing it precedes all component css. haze-ui has no global reset, so there is no missing-baseline risk.
- Vitest does not need this plugin: haze-ui ≥1.11 ships pure-ESM JS with zero css imports, so tests can run Node-direct.

## Options

```ts
hazeCss({packageName: 'haze-ui'}) // default; v1 only guarantees the default
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `packageName` | `string` | `'haze-ui'` | Package name to collect imports for. Reserved for generalization; only the default is exercised in v1. |

## The css-manifest contract

The plugin maps each named export to a css family file in two tiers:

1. **`dist/css-manifest.json` (haze-ui ≥1.22)** — shipped inside the haze-ui package as `{"families": {exportName: cssFileName}, "noCss": [exportName]}`. When present, it is the *only* mapping source. A malformed/unreadable manifest is a hard error (never a silent fallback — a publishing bug must not degrade into guess-based mapping).
2. **Built-in fallback tables** (`FAMILY` / `NO_CSS`, plus a kebab-case rule handling acronyms like `OTPInput → otp-input`) — used only when the installed haze-ui does not ship the manifest (≤1.21).

Whichever tier resolves the css file, the plugin verifies on disk — via `require.resolve` **based at the importing file** — that the css actually exists in the haze-ui copy that file consumes. Missing files fail fast with the four essentials: the triggering source file, the import name, the expected css path, and a fix hint.

Resolution base is the *consumer module* (`transform(code, id)`'s `id`), not the plugin's own location — the plugin lives in the consumer's `node_modules`, and resolving from there would be unreliable under pnpm strict layouts and monorepos. Resolution results and manifest state are cached per located install (keyed by the real `dist/css` directory), so multiple haze-ui copies in one monorepo never cross-contaminate.

## Known boundaries

- Only **direct named imports** from `haze-ui` are recognized. Re-exports through a local barrel (`export {X} from 'haze-ui'`) are not collected — import from `haze-ui` directly in the consuming module.
- **Namespace imports** (`import * as haze from 'haze-ui'`) collect nothing; the plugin warns in dev and suggests named imports.
- File-level granularity: importing a component anywhere in a file injects its css for that file (then deduped by the bundler).
- `import type` statements and inline `type` specifiers are skipped; imports inside `//` and `/* */` comments are stripped before scanning. Import-shaped text inside string literals may still be misrecognized — accepted, since the worst case is injecting one extra existing css file.

## Requirements

- Node ≥ 20
- Vite 5 / 6 / 7 / 8 (peer dependency)
- haze-ui ≥ 1.11 (pure-ESM dist); ≥ 1.22 recommended (ships `css-manifest.json`)

## License

MIT
# vite-plugin-haze-ui
