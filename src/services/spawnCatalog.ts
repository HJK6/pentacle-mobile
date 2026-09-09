export type SpawnProvider = 'claude' | 'codex';

export type SpawnCatalog = {
  schema_version: 'CatalogV1';
  catalog_version: string;
  profiles: Record<string, Partial<Record<SpawnProvider, [string, string]>>>;
  models: Record<SpawnProvider, Record<string, { aliases?: string[]; efforts: string[] }>>;
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

  return value as SpawnCatalog;
}
