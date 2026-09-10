# Pentacle Mobile

Pentacle Mobile lets you work with your coding-agent sessions from your phone.
It connects to the daemon in [**HJK6/pentacle**](https://github.com/HJK6/pentacle),
which runs on the computer where your agents work. Set up that daemon first;
the phone app does not run it. The desktop app is optional for mobile users.

## Getting started

1. Set up the [Pentacle daemon](https://github.com/HJK6/pentacle) on the computer
   where your coding agents run. The desktop app is optional.
2. Build and install this app on a simulator or phone.
3. Connect and enroll the app with your daemon, then open Chats.

The recommended way is to let a coding agent such as Fable or Astra handle
setup. Give it the path to [AGENT_SETUP.md](AGENT_SETUP.md). That separate guide
contains the full agent checklist. You may still need to complete provider
login, Apple signing or a device trust/unlock prompt yourself.

## Do I need chat-core separately?

**No.** [pentacle-chat-core](https://github.com/HJK6/pentacle-chat-core) is public,
and its source is already vendored at `pentacle-chat-core/`. The dependency is
`file:./pentacle-chat-core`, so `npm ci` installs the included copy. You do not
need another clone, a sibling directory or a separate core service. Desktop
vendors its own copy too.

## Manual quick start

You need Node.js 20.19.4+ and npm. For iOS, use a Mac with Xcode; Android builds
need the Android SDK. Expo and React Native are installed by npm.

```sh
git clone https://github.com/HJK6/pentacle-mobile.git
cd pentacle-mobile
npm ci
cp pentacle.config.example.ts pentacle.config.local.ts
```

Set the endpoint, app identifiers and host names using
[the setup guide](AGENT_SETUP.md#configure-the-app). Keep credentials out
of this ignored config file. Then, for a simulator:

```sh
npm run validate
npx expo prebuild --platform ios
npm run ios
```

Finally, [enroll the app](AGENT_SETUP.md#enroll-the-app) using a fresh link
issued on the daemon host. For a physical iPhone, follow the guide's device and
network steps. `npm start` runs Metro; it does not install or enroll an app.

## Development

Run `npm run typecheck` and `npm test` for offline checks. These do not prove
live connectivity. See [Testing](docs/TESTING.md) and
[Native builds](docs/PENTACLE_MOBILE_BUILD.md) for details. Normal builds compile
the vendored core automatically. Clear caches or regenerate native projects
only for an identified build problem, preserving existing native edits first.
