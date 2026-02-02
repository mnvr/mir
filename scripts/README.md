# Scripts

This directory contains local tooling and small utilities for the Mir repo.

## Playwright

Playwright can be used for scripted UI inspection in the desktop renderer
(runs in a browser).

Install the browsers once:

```sh
pnpm exec playwright install
```

Start the dev server:

```sh
pnpm dev:desktop
```

Run the script:

```sh
node scripts/inspect-layout.mjs
```

`inspect-layout.mjs` saves artifacts in `artifacts/`. You can override the
target URL by setting `INSPECT_URL`.
