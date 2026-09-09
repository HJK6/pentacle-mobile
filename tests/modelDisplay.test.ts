import { modelDisplayName } from '../src/services/modelDisplay';

const liveSpawnCatalogModelIds = [
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-fable-5',
  'gpt-5.6-terra',
  'gpt-5.6-sol',
] as const;

test('formats every current spawn-catalog model with a unique short display name', () => {
  expect(liveSpawnCatalogModelIds.map(modelDisplayName)).toEqual([
    'Opus 4.8',
    'Opus 5',
    'Sonnet 5',
    'Fable 5',
    '5.6 Terra',
    '5.6 Sol',
  ]);
  expect(new Set(liveSpawnCatalogModelIds.map(modelDisplayName)).size).toBe(liveSpawnCatalogModelIds.length);
});

test('falls back to the raw id for unrecognized model shapes', () => {
  expect(modelDisplayName('unknown-model')).toBe('unknown-model');
  expect(modelDisplayName('gpt-')).toBe('gpt-');
  expect(modelDisplayName('')).toBe('Unknown model');
});
