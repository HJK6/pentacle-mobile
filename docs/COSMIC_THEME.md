# Mobile Cosmic / Arcane Theme

The app uses a cosmic, arcane visual language. Each configured host adapter has
a sigil and accent color. This document covers styling only; it does not define
transport, host discovery, or application data.

## BRANDING

Keep the shipped images and palette to start from our defaults. To customize
your own build, replace the existing assets and edit the existing source tokens;
there is no additional branding config input.

### Logo assets

| File under `assets/images/` | Shipped size | Reference / use |
| --- | --- | --- |
| `icon.png` | 1024 × 1024 PNG | `app.config.ts` → `icon`; also the notifications plugin icon |
| `splash-icon.png` | 1024 × 1024 PNG | `app.config.ts` → `splash.image` (`contain`) |
| `favicon.png` | 256 × 256 PNG | `app.config.ts` → `web.favicon` |
| `adaptive-icon.png` | 1024 × 1024 PNG | Present but not referenced by the current config |

Replace files in place and keep their dimensions/PNG format. Use an opaque
square app icon, with artwork clear at small sizes; a splash logo may use
transparency against `splash.backgroundColor` (currently `#0f0f23`). Android
notification artwork needs a suitable monochrome silhouette; using your full
color launcher artwork for the current shared notification icon may not look
right. `pentacle_icon_source.png` and `pentacle_icon_source_chatgpt.png` are
source artwork, not runtime references: changing only those files does not
change an installed icon. Replacing `adaptive-icon.png` alone also has no effect;
the shipped config has no `android.adaptiveIcon` mapping.

### Colors

Edit `constants/Colors.ts`: `Colors.primary` (`#7ef0ba`) supplies shared UI and
navigation tint, while `Tokens.palette.green` (`#3dff66`) supplies the chat
accent. For an amber example, set each to `#ffb53d`; adjust `primaryDark`, surfaces,
text and borders as needed for contrast. Keep six-digit hex values for palette
tokens used with appended alpha bytes. Status/severity colors and host accents
are separate. Host-specific color/accent/sigil values already live in
`pentacle.config.local.ts` → `hosts`; see [app configuration](../AGENT_SETUP.md#configure-the-app).
That local config does not replace the shared global palette. The splash
background and notifications plugin color in `app.config.ts` are also separate
build-time values.

### Rebuild and reset

Record `git rev-parse HEAD` before branding and save any existing custom files.
After replacing native icons/splash artwork, regenerate and rebuild the native
app using [Native builds](PENTACLE_MOBILE_BUILD.md). Metro refresh alone does
not change installed launcher/splash assets. Preserve intentional native edits
before regeneration. Token edits can refresh through Metro in development;
release builds need a new JS bundle/build. For the web target, restart
`npx expo start --web --clear` and reload to see its favicon and palette.

To reset, restore only changed branding files from your recorded commit:

```sh
git restore --source=<defaults-commit> -- assets/images/icon.png assets/images/splash-icon.png assets/images/favicon.png constants/Colors.ts
```

Include `app.config.ts` only if you changed its branding settings, and save any
unrelated edits in the named files before restoring. Repeat the same native
regeneration/rebuild/install (or web restart/reload) so the installed app uses
the restored files. Changing source files alone does not reset an installed
binary. The configuration/asset mapping above is verified; the setup guide's
native build procedure applies to both custom and restored artwork.

## Design tokens

`constants/Colors.ts` contains the legacy `Colors` export and the shared
`Tokens`/`Theme` object. The palette uses dark ink and panel surfaces, pale
text, green success, amber warning, and red error accents. Type, spacing, card
bevel, and bubble radius values are centralized there.

The public host roster is deliberately neutral:

| Adapter | Sigil | Accent | Epithet |
|---|---|---|---|
| `hosta` | djinni | green | the djinni |
| `hostb` | sun | red | the flame |
| `hostc` | mage | cyan | the mage |
| `hostd` | flower | violet | the bloom |
| `hoste` | ibis | yellow | the scribe |

The roster is a theme vocabulary, not a fixed deployment requirement. Host
adapters discovered at runtime may use a fallback accent.

## Components and screens

- `MachineSigil`, `ArcaneRingFrame`, and `Starfield` provide deterministic
  decorative primitives.
- `Bevel`, `ProviderTag`, `StatusTag`, `SevTag`, and `ArcaneAtoms` are shared
  presentation components.
- The chats, session, updates, and settings screens use the same tokens.

Use flat surfaces without implicit shadows or glows. Fonts are registered by
the app layout and referenced through the exported font family map.

## Local visual harness

The screenshot harness loads synthetic pages from a local development server.
Its base URL can be overridden with `HARNESS_BASE_URL`:

```sh
npx expo start --web --port 8091
HARNESS_BASE_URL=http://localhost:8091 npm run mockups:screens
```

Baseline images belong under the local review directory. Keep them generated
from public fixtures and review any new asset's provenance and license before
redistributing it.
