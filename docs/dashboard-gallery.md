# Mockups in the phone browser

In Dashboards, select **Mockups** to open the shared web gallery in the phone's
browser. Choose a project, view and flow there to see its image, play and seek
its video, or use its interactive prototype. The app uses the existing catalog
order and browser retry control; it does not store or render another library.

The shared catalog represents Mockups as built-in board `ui-review`. Mobile
recognizes that one built-in and derives its browser URL from the current
configured Pentacle HTTPS origin followed by exactly `/designs/`; the web keeps
its inline built-in behavior. Other unknown built-ins remain unavailable.
Credentials, queries, fragments, path aliases, sibling
routes and mismatched ports are refused before Linking. Other permitted
tailnet hosted dashboards retain their existing policy. The current connected
daemon supplies the policy; a cached catalog cannot bypass missing policy.

The browser uses the existing Tailscale identity or provisioned web login.
Linking receives only the validated URL; the app supplies no token, headers or
cookies. If the browser cannot reach or authenticate to the gallery, retain the
actual error for the release owner. Native embedding and new login mechanisms
are outside this handoff.

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

The driver uses Playwright WebKit at 390 and 375 px, captures Mockups, browser
failure/retry and empty states, and checks the exact browser URL. It is a
phone-size preflight, not physical iPhone, Safari, Tailscale or media proof.
The fixture capture hides the unrelated web voice storage-error overlay under
an approved harness accommodation; it does not change the app or native proof.
Physical acceptance remains a release prerequisite: on the phone open
Dashboards → Mockups, verify Safari loads the configured origin's `/designs/`
using existing authentication, then open a project/view/flow and verify its PNG,
inline video playback and seeking, prototype navigation/animation, and refresh.
Retain the app, web and catalog revisions with that evidence.
