# Testing

From a fresh checkout, run npm ci, copy pentacle.config.example.ts to
pentacle.config.local.ts, then run npm run test:unit and npm run typecheck.
The shared chat core is vendored, so tests need no private repository or daemon.

For iteration, run npx jest --runInBand --runTestsByPath tests/<file>.test.ts.
Keep fixtures synthetic and preserve protocol fields, error messages, author
prefixes and config keys: those values affect behavior even in synthetic data.
The test host configuration uses hosta, hostb, and hostc.

npm run validate adds an iOS JavaScript export to TypeScript checking.
Jest covers modeled behavior; it does not certify native builds, device signing,
or live spawn/send journeys. Those require the configured daemon and native
runtime described in [Native builds](PENTACLE_MOBILE_BUILD.md).

The web harness can connect the real client to an isolated test daemon using the
EXPO_PUBLIC_HARNESS, EXPO_PUBLIC_HARNESS_TOKEN and EXPO_PUBLIC_PENTACLE_WS_URL
environment variables. Its credential must be synthetic and temporary; never
commit it. Native rejection-tracking options are loaded only on native platforms.
Verify a unique assistant response in the rendered chat, and verify actions stay
disabled when the daemon cannot be reached. This browser check does not replace
a signed native build or an iPhone runtime check.

The Summon picker uses configured and discovered host identities. Host labels
need not match the example palette; offline hosts remain visible but disabled.
