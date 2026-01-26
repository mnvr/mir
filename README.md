# Mir

This is Mir, a new way to interface with LLMs.

## Docs 📚

- `docs/user-guide.md`: User-facing documentation.

## Repository layout 🧭

- `apps/desktop`: Electron + React desktop app.
- `apps/mobile`: Expo + React Native mobile app.
- `packages/core`: Shared TypeScript types/logic.

## Requirements 🧩

### All platforms 🌍

- Node.js 20+ (includes Corepack).
- pnpm 10+ (`corepack enable` and `corepack prepare pnpm@10.26.2 --activate`, or install pnpm globally).

### macOS desktop 🍎

- No extra system dependencies for `pnpm dev:desktop`.

### iOS (macOS) 📱

- Xcode (for iOS Simulator and native builds).
- CocoaPods (required for `expo run:ios` / dev client builds; install with `brew install cocoapods` or `sudo gem install cocoapods`).

### Android 🤖

- Android Studio + Android SDK (for Android emulator and native builds).
- `ANDROID_HOME` set, with `platform-tools` on your PATH.

## Setup 🛠️

```sh
pnpm install
```

## Running 🚀

### Desktop (Electron) 🖥️

```sh
pnpm dev:desktop
```

```sh
pnpm build:desktop
```

### Mobile (Expo) 📲

Start Metro, then press `i` in the Metro terminal to run the app in the iOS Simulator, or `a` to run it on the Android emulator.

```sh
pnpm dev:mobile
```

Alternatively, you can start Metro + iOS Simulator in one command:

```sh
pnpm ios
```

Or launch Metro + Android emulator similarly with:

```sh
pnpm android
```

These run the app inside Expo Go on the simulator/emulator.

To run on a physical device (or when you need to recompile any of the custom native modules), use:

```sh
pnpm ios:device
```

```sh
pnpm android:device
```

These will create native builds. Hot reload will still work.

### Shared core package 🧰

`mir-core` is consumed from source in both apps, so changes should hot reload.

> If the mobile bundler misses updates, restart Metro.


### Playwright 🔍

Playwright can be used for scripted UI inspection in the desktop renderer (runs in a browser).

Install the browsers once,

```sh
pnpm exec playwright install
```

Start the dev server,

```sh
pnpm dev:desktop
```

And then run your playwright script, e.g.:

```sh
node scripts/inspect-layout.mjs
```

New scripts can be added as needed. This particular script saves artifacts in `artifacts/`, and the target URL can be overridden by setting the `INSPECT_URL` environment variable.

## Lint ✅

```sh
pnpm lint
```

Runs TypeScript and ESLint across the workspace.