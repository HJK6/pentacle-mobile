# Testing

From a fresh checkout, run npm ci, copy pentacle.config.example.ts to
pentacle.config.local.ts, then run npm run test:unit and npm run typecheck.
The shared chat core is vendored, so tests need no private repository or daemon.

For iteration, run npx jest --runInBand --runTestsByPath tests/<file>.test.ts.
Keep fixtures synthetic and preserve protocol fields, error messages, author
prefixes and config keys: those values affect behavior even in synthetic data.
The test host configuration uses hosta, hostb, and hostc.

Run npm run test:prod-build-guardrails to check the public production-build
environment allowlist, endpoint preflight, bundle fingerprint and baked-endpoint
checks, and sanitized evidence. This test uses synthetic inputs and does not
build or sign an app. The separate host-sigil test runs under test:unit.

npm run validate adds an iOS JavaScript export to TypeScript checking.
Jest covers modeled behavior; it does not certify native builds, device signing,
or live spawn/send journeys. Those require the configured daemon and native
runtime described in [Native builds](PENTACLE_MOBILE_BUILD.md).

`node test/e2e/assistant_question_rows.cjs` drives the actual Expo client at a
phone viewport against an owned scripted websocket daemon. Install its scoped
browser with `npx playwright install chromium` first. The walk keeps all five
fixture cards open, checks four questions on the composite row and a separate
independent seat, then uses the real composer to measure native Queued, echoed
Sent, and idle Sent before an echo. It requires mounted assistant replies and
exactly two sends, with no question answer/resolve/cancel requests. Verdict,
screenshots, wire frames and telemetry are retained in
`_artifacts/card-row/browser/`; its servers and browser are stopped on exit.
Optional `CARD_ROW_PRODUCER_STREAM_ID`, `CARD_ROW_SURFACE_STREAM_ID` and
`CARD_ROW_TITLE` inputs support a local identity replay without committing it.
Use `CARD_ROW_CARDS_ONLY=1` for the focused list reproduction and
`CARD_ROW_ARTIFACT_DIR` for a separate evidence directory. Use the identical
fixture and runner for baseline and candidate. This browser walk proves mobile
mapping, transport and captions; native certification and device activation
remain separate release gates.

Questions use the daemon's `surfaced_to_stream_id` for display while preserving
the producer as their answer destination. The inventory supplies an existing
row's provider; a question-only row uses explicit provider metadata or a legacy
provider-bearing ID. A v2 ID alone displays Agent. Native `provider_queued`
receipts retain a Queued marker until their correlated USER echo; an unqueued
landed receipt displays Sent immediately. Native queue ownership stays separate
from `turn_queued`, the client hold that `flushQueuedSends` may dispatch.

The web harness can connect the real client to an isolated test daemon using the
EXPO_PUBLIC_HARNESS, EXPO_PUBLIC_HARNESS_TOKEN and EXPO_PUBLIC_PENTACLE_WS_URL
environment variables. Its credential must be synthetic and temporary; never
commit it. Native rejection-tracking options are loaded only on native platforms.
Verify a unique assistant response in the rendered chat, and verify actions stay
disabled when the daemon cannot be reached. This browser check does not replace
a signed native build or an iPhone runtime check.

The Summon picker uses configured and discovered host identities. Host labels
need not match the example palette; offline hosts remain visible but disabled.

Public main is the normal development and build source. See [repository workflow](repo_workflow.md) for the mandatory pre-push content/history guard and required CI. Private-data exceptions use immediate reviewed public projection; keep local config out of Git.

The portable synthetic harness gate and retained private inputs are documented in [Public source boundary](public_boundary.md). CI runs only the four named Python mock/helper test files; JavaScript export validation uses the disposable ignored example config.
