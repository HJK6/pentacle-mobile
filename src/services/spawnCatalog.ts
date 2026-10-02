export type SpawnProvider = 'claude' | 'codex';

export type ModelDefinition = { aliases?: string[]; efforts: string[] };

export type SpawnCatalog = {
  schema_version: 'CatalogV1';
  catalog_version: string;
  profiles: Record<string, Partial<Record<SpawnProvider, [string, string]>>>;
  models: Record<SpawnProvider, Record<string, ModelDefinition>>;
  // Installation policy (daemon spawn_defaults[.local].json `available_models`):
  // the per-provider subset of `models`, in config list order, that the picker
  // should OFFER. Absent ⇒ the full `models` catalog is offered (shipped public
  // default). Narrowing is display-only: `models` stays authoritative for
  // explicit/handoff/default resolution. The daemon already sends this field.
  available_models?: Partial<Record<SpawnProvider, Record<string, ModelDefinition>>>;
};

const SPAWN_PROVIDERS: SpawnProvider[] = ['claude', 'codex'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function malformedCatalog(): never {
  throw new Error('The spawn catalog response is incomplete.');
}

export function validateSpawnCatalog(value: unknown): SpawnCatalog {
  if (!isRecord(value) || value.schema_version !== 'CatalogV1') malformedCatalog();
  if (typeof value.catalog_version !== 'string' || !value.catalog_version.trim()) malformedCatalog();
  if (!isRecord(value.profiles) || !isRecord(value.profiles.desktop_manual) || !isRecord(value.models)) malformedCatalog();

  for (const provider of SPAWN_PROVIDERS) {
    const providerModels = value.models[provider];
    const profileDefault = value.profiles.desktop_manual[provider];
    if (!isRecord(providerModels) || !Array.isArray(profileDefault) || profileDefault.length !== 2) malformedCatalog();
    const [defaultModel, defaultEffort] = profileDefault;
    if (typeof defaultModel !== 'string' || !defaultModel || typeof defaultEffort !== 'string' || !defaultEffort) malformedCatalog();

    for (const [model, definition] of Object.entries(providerModels)) {
      if (!model || !isRecord(definition) || !Array.isArray(definition.efforts) || definition.efforts.length === 0) malformedCatalog();
      if (!definition.efforts.every((effort) => typeof effort === 'string' && effort.length > 0)) malformedCatalog();
      if (definition.aliases !== undefined && (
        !Array.isArray(definition.aliases) ||
        !definition.aliases.every((alias) => typeof alias === 'string' && alias.length > 0)
      )) malformedCatalog();
    }

    const defaultDefinition = providerModels[defaultModel];
    if (!isRecord(defaultDefinition) || !Array.isArray(defaultDefinition.efforts) || !defaultDefinition.efforts.includes(defaultEffort)) {
      malformedCatalog();
    }
  }

  // `available_models`, when present, is a per-provider subset of `models` with
  // the same shape. Validate it so a malformed narrowing fails closed rather
  // than silently showing an empty or bogus picker; preserve its key order
  // (the picker renders in that order — operator dispatch 7c2717e4).
  if (value.available_models !== undefined) {
    if (!isRecord(value.available_models)) malformedCatalog();
    for (const [provider, providerModels] of Object.entries(value.available_models)) {
      if (!SPAWN_PROVIDERS.includes(provider as SpawnProvider) || !isRecord(providerModels)) malformedCatalog();
      // A present-but-empty provider map would narrow the picker to nothing.
      // Mirror the daemon's non-empty rule and fail closed (the picker also
      // falls back to the full catalog defensively — see SummonModal).
      if (Object.keys(providerModels).length === 0) malformedCatalog();
      const fullProviderModels = value.models[provider as SpawnProvider];
      for (const [model, definition] of Object.entries(providerModels)) {
        // Must be a subset of the authoritative `models` catalog.
        if (!model || !isRecord(fullProviderModels) || !isRecord(fullProviderModels[model])) malformedCatalog();
        if (!isRecord(definition) || !Array.isArray(definition.efforts) || definition.efforts.length === 0) malformedCatalog();
        if (!definition.efforts.every((effort) => typeof effort === 'string' && effort.length > 0)) malformedCatalog();
      }
    }
  }

  return value as SpawnCatalog;
}
