# Mobile Simulator Workflow

Use this loop for fast local validation with an iOS simulator. All commands
operate on the selected simulator and a local development server.

## Boot and run

```bash
xcrun simctl boot "iPhone 17 Pro" || true
open -a Simulator
cd ~/projects/mobile-app
npx expo start --dev-client --port 8081
```

In a second terminal:

```bash
cd ~/projects/mobile-app
npx expo run:ios -d "iPhone 17 Pro"
```

The Expo CLI uses `-d` for device selection. Start Metro before the first app
launch to avoid a temporary development-server screen.

## Relaunch and capture

```bash
xcrun simctl terminate booted com.example.pentacle.mobile || true
xcrun simctl launch booted com.example.pentacle.mobile
mkdir -p /tmp/mobile-screens
xcrun simctl io booted screenshot /tmp/mobile-screens/current.png
```

Check safe-area spacing, tab visibility, card hierarchy, and synthetic host or
chat counts.

## Useful checks

```bash
xcrun simctl list devices booted
xcrun simctl appinfo booted com.example.pentacle.mobile
npm run typecheck
npm run validate
```

The public deep link example is `example://chats`. If the simulator displays a
confirmation sheet, navigate in-app instead. Keep biometric-lock bypasses
limited to local development and disabled for release builds.
