# Native builds

Install Node dependencies with npm ci, then copy
pentacle.config.example.ts to pentacle.config.local.ts. Set a reachable
daemon websocket URL and your own app identifiers there. Never commit that file.

Run npm run test:unit and npm run validate before building. On macOS with
Xcode installed, run npx expo prebuild -p ios --clean, then npm run ios
to build and launch a simulator. Prebuild regenerates the native project;
keep intentional native changes in config plugins before using --clean.

For an iPhone, set your own bundle identifier and signing team in Xcode, enable
Developer Mode on the paired device, then run
npx expo run:ios --configuration Release --device.
For production builds set PENTACLE_PROD_BUILD=1 and a positive
PENTACLE_BUILD_NUMBER; see [Versioning](VERSIONING.md).

After installing, verify the installed bundle identifier and build version match
the signed app, launch it, open a chat, send a message, and confirm the assistant
reply renders. A successful build or launch alone does not prove connectivity.
