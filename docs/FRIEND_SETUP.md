# Set up Pentacle Mobile

Give a capable coding agent such as Fable or Astra the path to this file and ask
it to complete the setup. The agent should inspect the machine, reuse working
installations and verify a real conversation. Account login, signing, device
trust and unlocking may need the owner; do not claim those actions are complete
without observing them.

You need [pentacle](https://github.com/HJK6/pentacle) for the daemon and
[pentacle-mobile](https://github.com/HJK6/pentacle-mobile) for the app. You do
**not** need a separate [pentacle-chat-core](https://github.com/HJK6/pentacle-chat-core)
checkout. Each client vendors its source and installs it automatically with npm.

## Set up the daemon first

Follow the daemon repository's [SETUP.md](https://github.com/HJK6/pentacle/blob/main/SETUP.md)
and [local startup commands](https://github.com/HJK6/pentacle#local-setup).
For mobile-only use, install the Python dependencies, tmux and an authenticated
provider CLI; Electron is optional. Keep the daemon running while using the app.

Start with `--local-host local`. Verify the provider works under the same OS
user as the daemon. Keep the database, transcripts and credentials outside the
public checkout. Do not start a duplicate daemon if one is already working.

Choose the endpoint before building:

| App location | WebSocket endpoint |
| --- | --- |
| iOS simulator on the daemon's Mac | `ws://127.0.0.1:7791` |
| Physical phone or another computer | The daemon host's reachable LAN/VPN address, for example `ws://192.168.1.20:7791` |

Replace the example with the actual address. A phone's `localhost` is the phone,
not the Mac. For a phone, change the daemon's `--host` from loopback to its
private interface address and allow that port on the private network, or use a
suitable tunnel. Read [network access](https://github.com/HJK6/pentacle/blob/main/docs/REMOTE_AUTH.md).
Use an authenticated private network/tunnel or WSS across an untrusted network;
do not expose a plain WebSocket listener on the public internet.

## Configure the app

Use macOS with Xcode for iOS, Node.js 20.19.4+ and npm. In the mobile checkout:

```sh
npm ci
cp pentacle.config.example.ts pentacle.config.local.ts
```

Preserve an existing local config instead of replacing it. Set:

- `backend.wsUrl`: the endpoint selected above.
- `apple.bundleId`: your iOS identifier, such as `com.example.pentacle.mobile`.
- `apple.androidPackage`: your Android identifier if building Android.
- `hosts`: the daemon key with a readable label and color. Rename the example
  `laptop` key to `local` when following the default daemon setup.
- `hostOrder`: `['local']` for that single-host setup.
- `apple.expoOwner` and `apple.easProjectId`: your Expo/EAS values if using EAS;
  leave them empty for a local Xcode build instead of using example placeholders.
- `dashboardHub`: remove this optional example unless you have configured one.

Host keys identify daemon machines; labels are display text. Keep credentials
out of this ignored file. Enrollment stores them in the device's SecureStore.

## Build and install

For an initial simulator build:

```sh
npm run validate
npx expo prebuild --platform ios
npm run ios
```

Normal builds compile the vendored core. If you need to regenerate an existing
native project with `prebuild --clean`, preserve native edits first.

For a phone, connect and unlock it, enable Developer Mode, trust the Mac and
configure your Apple signing team in Xcode. Then install:

```sh
npx expo run:ios --configuration Release --device
```

A local Release build runs without Metro. Development signing may need renewal.
The repository's production profile also requires explicit identifiers and a
positive `PENTACLE_BUILD_NUMBER`; see [Native builds](PENTACLE_MOBILE_BUILD.md).

## Enroll the app

Wait until the app is installed and the daemon is reachable. On the **daemon
host**, as the **same OS user** running it, activate the Python venv and run this
from the `pentacle` repository:

```sh
python services/chat-stream-v2/tools/mobile_enrollment_cli.py \
  --ws-url ws://127.0.0.1:7791 --label simulator
```

For a phone, substitute its reachable endpoint and a label such as `phone`.
The JSON contains a secret `url` beginning with `pentacle://enroll`. It expires
after ten minutes and works once. It is **not** the raw credential envelope
from `operator_auth_cli.py issue`.

Open that exact URL on the target device. On a booted simulator, the agent can
use `xcrun simctl openurl booted '<enrollment-url>'`. For a phone, deliver it
privately as a tappable link or a locally generated QR code that opens the URL.
Keep the link out of reports, source files and screenshots. Issue a new one if
it expires before use.

The app exchanges the short code with the daemon, stores the credential in
SecureStore and opens Chats. Allow any required device authentication prompt.
No private enrollment service is needed.

## Verify and hand over

In Chats, create a session on `local`, send a short message and observe the
assistant reply in the app. Reopen the session and confirm it remains available.
A simulator can establish chat behavior; for a requested phone install, also
verify the installed version and launch.

If connection fails, check endpoint reachability, host identity and enrollment
before rebuilding. If spawning fails, check provider login on the daemon host.
Follow the actual error; do not repeat full native gates to troubleshoot setup.

Report source revisions, config paths, daemon start/stop commands, installed
target/version and the observed conversation. Keep secrets out of the report.
Name any remaining owner-only prerequisite and resume after it; do not call an
unfinished setup complete.
