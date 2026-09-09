import {
  computeAppVersion,
  computeBuildNumber,
  normalizeVersionBumpLevel,
} from '../app.config';
import path from 'node:path';

const { execFileSync } = jest.requireActual('node:child_process') as typeof import('node:child_process');

function runMarketingVersionHelper(buildNumber: string, bumpLevel?: string): string {
  const env = { ...process.env };
  if (bumpLevel) {
    env.PENTACLE_VERSION_BUMP = bumpLevel;
  } else {
    delete env.PENTACLE_VERSION_BUMP;
  }
  return execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'ios-marketing-version.cjs'), buildNumber], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env,
  }).trim();
}

beforeEach(() => {
  delete process.env.PENTACLE_BUILD_NUMBER;
  delete process.env.PENTACLE_PROD_BUILD;
  delete process.env.EAS_BUILD_PROFILE;
});

test('computes default minor app version from build number', () => {
  expect(computeAppVersion('1')).toBe('1.0.0');
  expect(computeAppVersion('2')).toBe('1.1.0');
  expect(computeAppVersion('3')).toBe('1.2.0');
});

test('supports major and patch version bump overrides', () => {
  expect(computeAppVersion('2', 'major')).toBe('2.0.0');
  expect(computeAppVersion('2', 'patch')).toBe('1.0.1');
});

test('native marketing-version helper matches app config at build 4', () => {
  expect(runMarketingVersionHelper('4')).toBe('1.3.0');
  expect(runMarketingVersionHelper('4', 'major')).toBe('4.0.0');
  expect(runMarketingVersionHelper('4', 'patch')).toBe('1.0.3');
});

test('normalizes version bump override with minor default', () => {
  expect(normalizeVersionBumpLevel(undefined)).toBe('minor');
  expect(normalizeVersionBumpLevel('PATCH')).toBe('patch');
  expect(() => normalizeVersionBumpLevel('build')).toThrow(/PENTACLE_VERSION_BUMP/);
});

test('development builds default to one and accept an explicit number', () => {
  expect(computeBuildNumber()).toBe('1');
  process.env.PENTACLE_BUILD_NUMBER = '42';
  expect(computeBuildNumber()).toBe('42');
});

test.each(['PENTACLE_PROD_BUILD', 'EAS_BUILD_PROFILE'])('production profile %s requires a build number', (key) => {
  process.env[key] = key === 'PENTACLE_PROD_BUILD' ? '1' : 'production';
  expect(() => computeBuildNumber()).toThrow(/PENTACLE_BUILD_NUMBER is required/);
  process.env.PENTACLE_BUILD_NUMBER = '42';
  expect(computeBuildNumber()).toBe('42');
});

test.each(['0', '-1', '1.5', 'abc'])('rejects invalid explicit build number %s', (value) => {
  process.env.PENTACLE_BUILD_NUMBER = value;
  expect(() => computeBuildNumber()).toThrow(/positive integer/);
});
