import { normalizePentacleHost } from 'pentacle-chat-core';

test('normalizes host names by trimming and lowercasing', () => {
  expect(normalizePentacleHost('  hostc  ')).toBe('hostc');
  expect(normalizePentacleHost('hostb')).toBe('hostb');
});

test('normalizes empty and non-string host inputs defensively', () => {
  expect(normalizePentacleHost('')).toBe('');
  expect(normalizePentacleHost(null as unknown as string)).toBe('');
});


