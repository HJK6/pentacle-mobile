import {
  computeAppVersion,
  computeBuildNumber,
  normalizeVersionBumpLevel,
} from '../app.config';
import path from 'node:path';

jest.mock('node:child_process', () => ({
  execSync: jest.fn(),
}));

const execSync = require('node:child_process').execSync as jest.Mock;
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
  execSync.mockReset();
});

test('computes default minor app version from build number', () => {
  expect(computeAppVersion('390')).toBe('2.0.0');
  expect(computeAppVersion('391')).toBe('2.1.0');
  expect(computeAppVersion('392')).toBe('2.2.0');
});

test('supports major and patch version bump overrides', () => {
  expect(computeAppVersion('391', 'major')).toBe('3.0.0');
  expect(computeAppVersion('391', 'patch')).toBe('2.0.1');
});

test('native marketing-version helper matches app config at build 393', () => {
  expect(runMarketingVersionHelper('393')).toBe('2.3.0');
  expect(runMarketingVersionHelper('393', 'major')).toBe('5.0.0');
  expect(runMarketingVersionHelper('393', 'patch')).toBe('2.0.3');
});

test('normalizes version bump override with minor default', () => {
  expect(normalizeVersionBumpLevel(undefined)).toBe('minor');
  expect(normalizeVersionBumpLevel('PATCH')).toBe('patch');
  expect(() => normalizeVersionBumpLevel('build')).toThrow(/PENTACLE_VERSION_BUMP/);
});

test('keeps build number derived from git commit count', () => {
  execSync.mockImplementation((command: string) => {
    if (command.includes('--is-shallow-repository')) return 'false\n';
    if (command.includes('rev-list --count HEAD')) return '391\n';
    throw new Error(`unexpected command ${command}`);
  });

  expect(computeBuildNumber()).toBe('391');
});

test('build number derivation rejects shallow clones', () => {
  execSync.mockImplementation((command: string) => {
    if (command.includes('--is-shallow-repository')) return 'true\n';
    throw new Error(`unexpected command ${command}`);
  });

  expect(() => computeBuildNumber()).toThrow(/shallow clone/);
});
