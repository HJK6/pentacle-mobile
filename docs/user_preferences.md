# User Preferences

`src/services/userPreferences.ts` is the app-local preference singleton. It
stores non-secret UX preferences in `AsyncStorage` and exposes synchronous
snapshots to React with `useSyncExternalStore`.

## Current shape

```typescript
export type UserPreferences = {
  showToolActions: boolean;
  showTurnDuration: boolean;
};
```

Both values default to `false`. Tool rows stay hidden until the user opts in;
turn-duration divider rows remain a render-layer choice and do not disappear
from reducer state or turn-end detection.

The serialized key is `mobile:user-preferences:v1`. Preferences are not
credentials. Authentication material belongs in the platform secure store.

## Hydration semantics

Hydration starts in the background when the module loads or when a getter or
subscriber first asks for state. Reads return documented defaults until the
storage read resolves. Parsed data merges only known keys and falls back to
defaults for missing or invalid values.

Mutations update memory first, notify listeners when a value changes, and then
persist the complete preference object. If a mutation occurs during hydration,
the hydration result must not overwrite the newer in-memory value.

React callers use:

```typescript
const [showToolActions, setShowToolActions] = useUserPreference('showToolActions');
```

## Adding a key

1. Add it to `UserPreferences` and the documented defaults.
2. Validate it in the stored-payload parser.
3. Include it in equality checks so no-op updates remain stable.
4. Expose it through `useUserPreference` at the call site.
5. Test defaults, hydration, persistence, and listener notification.

Use this module only for ordinary client preferences; never store secrets here.
