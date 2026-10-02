import { validateSpawnCatalog } from '../src/services/spawnCatalog';

// available_models is an optional per-provider SUBSET of models, in config list
// order, that the picker offers (PR#53 + operator dispatch 7c2717e4). The
// validator must accept a well-formed subset (preserving key order), tolerate
// its absence, and fail closed on a listed model that is not in `models`.

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const base = () => ({
  schema_version: 'CatalogV1',
  catalog_version: 'spawn-catalog-v1',
  profiles: { desktop_manual: { claude: ['claude-opus-4-8', 'high'], codex: ['gpt-6-luna', 'high'] } },
  models: {
    claude: { 'claude-opus-4-8': { efforts: EFFORTS }, 'claude-opus-5-5': { efforts: EFFORTS }, 'claude-sonnet-5-5': { efforts: EFFORTS }, 'claude-fable-5-1': { efforts: EFFORTS } },
    codex: { 'gpt-5.6-sol': { efforts: EFFORTS }, 'gpt-6-sol': { efforts: EFFORTS }, 'gpt-6.1-sol': { efforts: EFFORTS }, 'gpt-6-luna': { efforts: EFFORTS }, 'gpt-6-astra': { efforts: EFFORTS } },
  },
}) as any;

test('accepts a catalog with no available_models (shipped public default)', () => {
  const catalog = validateSpawnCatalog(base());
  expect(catalog.available_models).toBeUndefined();
});

test('accepts a valid subset and preserves its list order', () => {
  const input = base();
  input.available_models = {
    codex: { 'gpt-6-luna': { efforts: EFFORTS }, 'gpt-6.1-sol': { efforts: EFFORTS }, 'gpt-6-astra': { efforts: EFFORTS } },
    claude: { 'claude-opus-4-8': { efforts: EFFORTS }, 'claude-opus-5-5': { efforts: EFFORTS }, 'claude-fable-5-1': { efforts: EFFORTS } },
  };
  const catalog = validateSpawnCatalog(input);
  expect(Object.keys(catalog.available_models!.codex!)).toEqual(['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra']);
  expect(Object.keys(catalog.available_models!.claude!)).toEqual(['claude-opus-4-8', 'claude-opus-5-5', 'claude-fable-5-1']);
});

test('rejects available_models listing a model absent from the full catalog', () => {
  const input = base();
  input.available_models = { codex: { 'gpt-9-nope': { efforts: EFFORTS } } };
  expect(() => validateSpawnCatalog(input)).toThrow(/incomplete/);
});

test('rejects available_models under an unknown provider', () => {
  const input = base();
  input.available_models = { nope: { 'gpt-6-luna': { efforts: EFFORTS } } };
  expect(() => validateSpawnCatalog(input)).toThrow(/incomplete/);
});
