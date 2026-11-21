# Design on iOS

Open **Design** from the Dashboards tab to browse the shared design library
inside Pentacle. A Design preview in chat opens the linked board or screen.
A Design chip opens Home. Use native **Back** to return to the originating
screen. The preview uses the recorded image attached to the message and keeps
the caption visible. If the image is unavailable, the text preview still opens
the linked design.

The shared catalog keeps the built-in ID `ui-review`, its current label, and
its membership, visibility and order. The iOS app displays the Design label
for that ID. Other hosted dashboards retain their existing browser policy.

The native view loads the exact HTTPS origin admitted by the current hosted
dashboard policy. It accepts only the standalone Design Home, board and screen
addresses built from the shared chat link target. It sends no app credentials,
injected headers or browser login cookies. The viewer requires the device's
Tailscale identity. If the policy, authentication or main document fails, the
screen offers **Try again** and reads the current policy again.

## Legacy Mockups browser entry

The shared catalog represents Mockups as built-in board `ui-review`. Mobile
recognizes that one built-in and derives its browser URL from the current
configured Pentacle HTTPS origin followed by exactly `/designs/`; the web keeps
its inline built-in behavior. Other unknown built-ins remain unavailable.
Credentials, queries, fragments, path aliases, sibling
routes and mismatched ports are refused before Linking. Other permitted
tailnet hosted dashboards retain their existing policy. The current connected
daemon supplies the policy; a cached catalog cannot bypass missing policy.

The legacy browser entry continues to use its existing Tailscale identity or
provisioned web login. Linking receives only the validated URL.

For source verification, run the catalog loader and catalog screen Jest suites,
then `npm run test:unit`, `npm run typecheck` and `npm run validate` with the
ignored synthetic example config. The offline screenshot fixture uses the real
Dashboards screen and synthetic catalog/policy boundaries:

```sh
EXPO_PUBLIC_SCREENSHOT_HARNESS=1 EXPO_PUBLIC_HARNESS=1 \
EXPO_PUBLIC_DISABLE_BIOMETRIC_LOCK=1 EXPO_PUBLIC_DASHBOARD_RENDER_FIXTURE=1 \
npm run web -- --port 8081
PENTACLE_RENDER_URL=http://127.0.0.1:8081 \
PENTACLE_RENDER_OUTPUT=/absolute/external/evidence \
node scripts/mockups-dashboard-render.cjs
```

The browser driver uses Playwright WebKit at 390 and 375 px and exercises the
legacy selector, browser failure/retry and empty states.

The installed iOS gate exercises the Design entry and a seeded chat preview
with the accepted standalone viewer. Record the selected screen, native Back
and transcript position, viewer gestures, and failure/Retry evidence along
with the app, web and catalog revisions. Record paired-device Tailscale
admission separately when a paired device is reachable.
