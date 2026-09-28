/**
 * Coverage for `scripts/assert-embedded-bundle.cjs`.
 *
 * This guard exists to prove that THIS build embedded a JS bundle. It has already regressed
 * twice into a false pass (a stale bundle from a previous build, then a set of fail-open
 * argument and stat checks found by QA on fa83eec7) because it was only ever exercised by
 * hand. Every accept/reject boundary below is one of those observed false passes.
 *
 * `xcodebuild` is stubbed via PATH so these run anywhere in milliseconds.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'assert-embedded-bundle.cjs');
const PLAUSIBLE_BYTES = 512 * 1024;

type RunResult = { status: number; stdout: string; stderr: string };

function makeWorkspace(): { root: string; appPath: string; binDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-embedded-bundle-'));
  const buildDir = path.join(root, 'Build', 'Products', 'Release-iphonesimulator');
  const appPath = path.join(buildDir, 'Pentacle.app');
  fs.mkdirSync(appPath, { recursive: true });

  // Stub `xcodebuild -showBuildSettings -json` to describe exactly one .app product.
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir);
  const payload = JSON.stringify([
    { target: 'Pentacle', buildSettings: { TARGET_BUILD_DIR: buildDir, FULL_PRODUCT_NAME: 'Pentacle.app' } },
  ]);
  fs.writeFileSync(
    path.join(binDir, 'xcodebuild'),
    `#!/bin/sh\ncat <<'JSON'\n${payload}\nJSON\n`,
    { mode: 0o755 },
  );
  return { root, appPath, binDir };
}

function writeBundle(appPath: string, bytes: number, mtimeEpochSeconds?: number): string {
  const bundlePath = path.join(appPath, 'main.jsbundle');
  fs.writeFileSync(bundlePath, Buffer.alloc(bytes, 0x61));
  if (mtimeEpochSeconds !== undefined) {
    fs.utimesSync(bundlePath, mtimeEpochSeconds, mtimeEpochSeconds);
  }
  return bundlePath;
}

function run(binDir: string, args: string[]): RunResult {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('assert-embedded-bundle', () => {
  const workspaces: string[] = [];
  const setup = () => {
    const ws = makeWorkspace();
    workspaces.push(ws.root);
    return ws;
  };
  afterAll(() => {
    workspaces.forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
  });

  const now = () => Math.floor(Date.now() / 1000);

  it('passes a plausible bundle written after the pre-build stamp', () => {
    const { appPath, binDir } = setup();
    const stamp = now() - 60;
    writeBundle(appPath, PLAUSIBLE_BYTES, stamp + 30);

    const result = run(binDir, ['-scheme', 'Pentacle', '--min-mtime', String(stamp)]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK');
  });

  it.each([
    ['empty', ''],
    ['zero', '0'],
    ['negative', '-1'],
    ['non-numeric', 'yesterday'],
  ])('rejects a %s --min-mtime instead of treating it as "any bundle will do"', (_label, value) => {
    const { appPath, binDir } = setup();
    writeBundle(appPath, PLAUSIBLE_BYTES, now() - 86400);

    const result = run(binDir, ['-scheme', 'Pentacle', '--min-mtime', value]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--min-mtime');
  });

  it('rejects a repeated --min-mtime instead of letting the weaker value win', () => {
    const { appPath, binDir } = setup();
    const stamp = now() - 60;
    writeBundle(appPath, PLAUSIBLE_BYTES, stamp - 3600);

    // Last-wins would silently choose the permissive trailing stamp over the future one.
    const result = run(binDir, [
      '-scheme', 'Pentacle',
      '--min-mtime', String(now() + 3600),
      '--min-mtime', '1',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--min-mtime');
  });

  it('accepts a bundle whose mtime equals the stamp exactly — a same-second build is legitimate', () => {
    const { appPath, binDir } = setup();
    const stamp = now() - 60;
    writeBundle(appPath, PLAUSIBLE_BYTES, stamp);

    const result = run(binDir, ['-scheme', 'Pentacle', '--min-mtime', String(stamp)]);

    expect(result.status).toBe(0);
  });

  it('rejects a bundle only one second older than the stamp — no fail-open slack', () => {
    const { appPath, binDir } = setup();
    const stamp = now() - 60;
    writeBundle(appPath, PLAUSIBLE_BYTES, stamp - 1);

    const result = run(binDir, ['-scheme', 'Pentacle', '--min-mtime', String(stamp)]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('STALE');
  });

  it('rejects a symlink standing in for an embedded bundle', () => {
    const { root, appPath, binDir } = setup();
    const stamp = now() - 60;
    const external = path.join(root, 'elsewhere.jsbundle');
    fs.writeFileSync(external, Buffer.alloc(PLAUSIBLE_BYTES, 0x61));
    fs.symlinkSync(external, path.join(appPath, 'main.jsbundle'));

    const result = run(binDir, ['-scheme', 'Pentacle', '--min-mtime', String(stamp)]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('symlink');
  });

  it('rejects a directory named main.jsbundle', () => {
    const { appPath, binDir } = setup();
    fs.mkdirSync(path.join(appPath, 'main.jsbundle'));

    const result = run(binDir, ['-scheme', 'Pentacle', '--min-mtime', String(now() - 60)]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not a regular file');
  });

  it('rejects a token-sized bundle that satisfies a bare size > 0 check', () => {
    const { appPath, binDir } = setup();
    const stamp = now() - 60;
    writeBundle(appPath, 2, stamp + 30);

    const result = run(binDir, ['-scheme', 'Pentacle', '--min-mtime', String(stamp)]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('implausibly small');
  });

  it('rejects a symlinked .app wrapper pointing at a bundle this build did not produce', () => {
    const { root, appPath, binDir } = setup();
    const stamp = now() - 60;
    const external = path.join(root, 'External.app');
    fs.mkdirSync(external);
    writeBundle(external, PLAUSIBLE_BYTES, stamp + 30);
    fs.rmSync(appPath, { recursive: true, force: true });
    fs.symlinkSync(external, appPath);

    const result = run(binDir, ['-scheme', 'Pentacle', '--min-mtime', String(stamp)]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('symlink');
  });

  it('reports a missing bundle as a skipped bundling phase', () => {
    const { binDir } = setup();

    const result = run(binDir, ['-scheme', 'Pentacle', '--min-mtime', String(now() - 60)]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no main.jsbundle');
  });
});
