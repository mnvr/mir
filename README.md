# Mir

This is Mir, a new way to interface with LLMs.

## Repo layout

- `apps/desktop`: Electron + React desktop app.
- `apps/mobile`: Expo + React Native mobile app.
- `packages/core`: Shared TypeScript types/logic.

## Requirements

### All platforms

- Node.js 20+ (includes Corepack).
- pnpm 10+ (`corepack enable` and `corepack prepare pnpm@10.26.2 --activate`, or install pnpm globally).

### macOS desktop

- No extra system dependencies for `pnpm dev:desktop`.

### iOS (macOS)

- Xcode (for iOS Simulator and native builds).
- CocoaPods (required for `expo run:ios` / dev client builds; install with `brew install cocoapods` or `sudo gem install cocoapods`).

### Android

- Android Studio + Android SDK.
- `ANDROID_HOME` set, with `platform-tools` on your PATH.

## Setup

```sh
pnpm install
```

## Desktop (macOS)

```sh
pnpm dev:desktop
```

```sh
pnpm build:desktop
```

## Mobile (Expo)

Start the Metro bundler:

```sh
pnpm dev:mobile
```

Launch iOS Simulator (requires Xcode):

```sh
pnpm ios
```

Launch Android emulator/device (requires Android Studio):

```sh
pnpm android
```

## Native builds (optional)

For native builds or when you need custom native modules, use Expo's run commands.
These generate native projects on first run.

```sh
cd apps/mobile
npx expo run:ios
```

```sh
cd apps/mobile
npx expo run:android
```

## Shared core package

Build the shared TypeScript package:

```sh
pnpm --filter mir-core build
```
