# Pentacle Mobile

An Expo / React Native client for Pentacle coding-agent sessions. It bundles the
standalone `pentacle-chat-core` library from an in-repo vendor directory and
talks to a Pentacle daemon endpoint you configure.

## Requirements

- Node.js >= 20.19.4 and npm.
- Expo ~54 / React Native 0.81.x (installed via npm below).
- For a native build: Xcode (iOS) or Android SDK, plus the Expo prebuild
  toolchain.

## Install

No lockfile is published; `npm install` resolves dependencies, including the
vendored core via its in-repo `file:` path. A real `package-lock.json` is
regenerated as your repository's first follow-up commit.

```sh
npm install
```

`pentacle-chat-core` is vendored at `./pentacle-chat-core` and referenced as
`"pentacle-chat-core": "file:./pentacle-chat-core"` — the in-repo path, never a
sibling checkout.

## Configure

```sh
cp pentacle.config.example.ts pentacle.config.local.ts
```

Edit `pentacle.config.local.ts` to set your daemon endpoint and generic
bundle / signing / EAS identifiers. No credentials or private identifiers are
bundled; development uses build number 1 until you choose a production identity.

## Typecheck and test

```sh
npm run typecheck        # tsc --noEmit
npm test                 # jest unit suite
```

These run offline against the source tree with a throwaway `HOME`; no live
service or production endpoint is contacted.

## Run and native build (source-dependency fallback)

```sh
npm start                # expo start (Metro dev server)
```

For a fresh clean-room native build that compiles the vendored core from source
(the source-dependency fallback, not a cached or prebuilt artifact), clear
caches and build from the checked-out tree:

```sh
npm install                                   # resolves the file: core vendor from source
npx expo prebuild --clean                     # regenerate native projects
npm run ios        # expo run:ios   (or: npm run android)
```

The build compiles `pentacle-chat-core` from its vendored TypeScript source; it
does not fetch a prebuilt package or a redirected artifact URL. Use fresh caches
(`--clean`) so the fallback path is exercised end to end.


## Known test gaps

The default `npm test` / `npm run typecheck` suites are not fully green yet; the residuals are anonymization/config drift and selector logic, not privacy, install, or configure issues (anonymous dependency install and `expo prebuild --clean` pass). They are being greened in the open as the first follow-up: machine-tab label normalization (`selectMachineStatsTabs`), the app config version/build-number stamp, a telemetry path, and PentacleChatModel selector logic. Device/simulator tests are gated behind `PENTACLE_NATIVE_TESTS=1`.
