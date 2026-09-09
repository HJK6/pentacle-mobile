# Development Environment

## Persistent Client Storage

Pentacle Mobile uses SecureStore for privileged authentication material and AsyncStorage for non-secret user preferences. The current AsyncStorage preference document is `pentacle-mobile:user-preferences:v1`, owned by `src/services/userPreferences.ts`, and includes the chat `showToolActions` preference (`src/services/userPreferences.ts:8`).
