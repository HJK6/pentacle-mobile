# Local Mobile Setup

This guide builds a local iPhone or simulator copy of the mobile client against
a local or otherwise public structured-event adapter. It intentionally does not
document private enrollment services or live deployment credentials.

## Prerequisites

- macOS with Xcode and an Apple ID configured for local development;
- an iPhone with Developer Mode enabled, or an iOS simulator;
- this repository and Node.js dependencies installed with `npm install`;
- a local fixture backend if live event data is needed.

Free Apple Developer accounts may require periodic re-signing for local USB
installs.

## Application identity

Choose an identifier you control for local signing, for example:

```text
com.example.pentacle.mobile
```

Use the same value for the iOS bundle id and, if needed, the Android package.
The Xcode project leaves the development team unset so each developer can
select their own signing identity.

## Local configuration

Copy the example configuration when the repository provides one:

```bash
cp pentacle.config.example.ts pentacle.config.local.ts
```

Set only local, non-secret development values:

- `apple.bundleId`: the identifier chosen above;
- `apple.androidPackage`: the Android package, if building Android;
- `backend.wsUrl`: `ws://localhost:8080` for a local fixture adapter;
- `hosts`: neutral display labels such as `hosta` and `hostb`;
- `hostOrder`: optional deterministic display order.

Keep local configuration ignored by version control. Use the platform secure
store for real credentials; do not put tokens in source, fixtures, or docs.

## First build

```bash
npm install
npm run validate
npm run ios:device
```

For a simulator, use `npx expo run:ios`. If native folders were generated with
different local identity values, regenerate them with `npx expo prebuild --clean`
before the next build.
