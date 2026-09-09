# Mobile Cosmic / Arcane Theme

The app uses a cosmic, arcane visual language. Each configured host adapter has
a sigil and accent color. This document covers styling only; it does not define
transport, host discovery, or application data.

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
