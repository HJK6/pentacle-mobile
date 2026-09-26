import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const prodBuild = require('../scripts/prod-build.cjs') as {
  buildCleanProductionEnv: (env: Record<string, string | undefined>) => Record<string, string | undefined>;
  guardProductionExpoPublicEnv: (env: Record<string, string | undefined>) => void;
  verifyProdBundleFingerprints: (targetPaths: string[]) => string[];
  resolveProductionEndpoint: (options?: {
    env?: Record<string, string | undefined>;
    readConfig?: () => { backend?: { wsUrl?: string } };
  }) => {
    endpoint: string;
    sanitizedEndpoint: string;
    source: { kind: string; name: string };
  };
  runIosDevice: (options?: {
    env?: Record<string, string | undefined>;
    exportDir?: string;
    readConfig?: () => { backend?: { wsUrl?: string } };
    runCommand?: (argv: string[], options: Record<string, unknown>) => number;
  }) => number;
};

describe('production build guardrails', () => {
  test('rejects harness and future public env in production', () => {
    expect(() =>
      prodBuild.guardProductionExpoPublicEnv({
        EXPO_PUBLIC_DISABLE_BIOMETRIC_LOCK: '1',
        EXPO_PUBLIC_HARNESS: '1',
        EXPO_PUBLIC_NEW_TEST_FLAG: '1',
      }),
    ).toThrow(/EXPO_PUBLIC_DISABLE_BIOMETRIC_LOCK.*EXPO_PUBLIC_HARNESS.*EXPO_PUBLIC_NEW_TEST_FLAG/);
  });

  test('keeps production public allowlist but drops ambient shell env', () => {
    const clean = prodBuild.buildCleanProductionEnv({
      EXPO_PUBLIC_PENTACLE_WS_URL: 'wss://example.invalid',
      EXPO_PUBLIC_PROJECT_ROOT: '/tmp/expo-project',
      PATH: '/usr/bin',
      PENTACLE_VERSION_BUMP: 'patch',
      TEST_AMBIENT_SECRET: 'leak',
    });
    expect(clean.EXPO_PUBLIC_PENTACLE_WS_URL).toBe('wss://example.invalid');
    expect(clean.EXPO_PUBLIC_PROJECT_ROOT).toBe('/tmp/expo-project');
    expect(clean.LANG).toBe('en_US.UTF-8');
    expect(clean.PATH).toBe('/usr/bin');
    expect(clean.PENTACLE_PROD_BUILD).toBe('1');
    expect(clean.PENTACLE_VERSION_BUMP).toBe('patch');
    expect(clean.TEST_AMBIENT_SECRET).toBeUndefined();
  });

  test('public production profile and Expo config route through the guard', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const easJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'eas.json'), 'utf8'));
    const appConfig = fs.readFileSync(path.join(__dirname, '..', 'app.config.ts'), 'utf8');

    expect(packageJson.scripts['test:prod-build-guardrails']).toBe(
      'jest --runTestsByPath tests/prodBuildGuardrails.test.ts --runInBand',
    );
    expect(easJson.build.production.env.PENTACLE_PROD_BUILD).toBe('1');
    expect(appConfig).toContain("require('./scripts/prod-build.cjs')");
    expect(appConfig).toContain('guardProductionExpoPublicEnv');
    expect(appConfig).toContain('const effectiveWsUrl = process.env.EXPO_PUBLIC_PENTACLE_WS_URL || config.backend.wsUrl');
  });

  test('fingerprint verifier rejects test flags in built artifacts', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-build-guard-'));
    try {
      const cleanBundle = path.join(tmp, 'main.jsbundle');
      fs.writeFileSync(cleanBundle, 'production bundle');
      expect(prodBuild.verifyProdBundleFingerprints([tmp])).toEqual([cleanBundle]);

      fs.writeFileSync(cleanBundle, 'EXPO_PUBLIC_DISABLE_BIOMETRIC_LOCK');
      expect(() => prodBuild.verifyProdBundleFingerprints([tmp])).toThrow(/DISABLE_BIOMETRIC_LOCK/);

      // The simulator-enrollment credential-injection param must never survive
      // into a production bundle (it lives behind the EXPO_PUBLIC_HARNESS gate).
      fs.writeFileSync(cleanBundle, "harnessRuntime.getParam('install_device_token')");
      expect(() => prodBuild.verifyProdBundleFingerprints([tmp])).toThrow(/install_device_token/);
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });

  test.each([
    ['malformed', 'not a websocket endpoint'],
    ['example host', 'wss://api.example.com:7791/ws'],
    ['TEST-NET', 'ws://192.0.2.1:7791'],
    ['loopback name', 'ws://localhost:7791'],
    ['loopback address', 'ws://127.0.0.1:7791'],
  ])('rejects %s control-plane endpoints', (_label, endpoint) => {
    expect(() =>
      prodBuild.resolveProductionEndpoint({
        env: { EXPO_PUBLIC_PENTACLE_WS_URL: endpoint },
        readConfig: () => ({ backend: { wsUrl: 'wss://control.fixture.internal:7791/ws' } }),
      }),
    ).toThrow(/production endpoint|control-plane|endpoint/i);
  });

  test('rejects a missing local control-plane endpoint', () => {
    expect(() =>
      prodBuild.resolveProductionEndpoint({
        env: {},
        readConfig: () => ({ backend: {} }),
      }),
    ).toThrow(/production endpoint|control-plane|endpoint/i);
  });

  test('accepts a structural production endpoint and identifies its source', () => {
    const resolved = prodBuild.resolveProductionEndpoint({
      env: { EXPO_PUBLIC_PENTACLE_WS_URL: 'wss://control.fixture.internal:7791/ws' },
      readConfig: () => ({ backend: { wsUrl: 'wss://unused.fixture.internal:7791/ws' } }),
    });

    expect(resolved.endpoint).toBe('wss://control.fixture.internal:7791/ws');
    expect(resolved.sanitizedEndpoint).toBe('wss://control.fixture.internal:7791');
    expect(resolved.source).toEqual({ kind: 'environment', name: 'EXPO_PUBLIC_PENTACLE_WS_URL' });
  });

  test('resolves the local config source when the runtime env override is absent', () => {
    const resolved = prodBuild.resolveProductionEndpoint({
      env: {},
      readConfig: () => ({ backend: { wsUrl: 'wss://local.fixture.internal:7791' } }),
    });

    expect(resolved.endpoint).toBe('wss://local.fixture.internal:7791');
    expect(resolved.source).toEqual({ kind: 'local-config', name: 'pentacle.config.local.ts:backend.wsUrl' });
  });

  test('invalid endpoint fails before export or native build', () => {
    const runCommand = jest.fn(() => 0);

    expect(() =>
      prodBuild.runIosDevice({
        env: { PENTACLE_IOS_RELEASE_EXPORT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'prod-endpoint-red-')) },
        readConfig: () => ({ backend: { wsUrl: 'ws://192.0.2.1:7791' } }),
        runCommand,
      }),
    ).toThrow(/production endpoint|TEST-NET/i);
    expect(runCommand).not.toHaveBeenCalled();
  });

  test('matching exported bundle emits sanitized evidence before native build', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-endpoint-green-'));
    const endpoint = 'wss://control.fixture.internal:7791/ws?token=fixture-secret';
    const calls: string[][] = [];
    const commandOptions: Array<Record<string, unknown>> = [];
    try {
      const runCommand = (argv: string[], options: Record<string, unknown>) => {
        calls.push(argv);
        commandOptions.push(options);
        if (argv[1] === 'export') {
          fs.mkdirSync(tmp, { recursive: true });
          fs.writeFileSync(path.join(tmp, 'main.jsbundle'), `bundle endpoint ${endpoint}`);
        }
        return 0;
      };

      expect(
        prodBuild.runIosDevice({
          env: {},
          exportDir: tmp,
          readConfig: () => ({ backend: { wsUrl: endpoint }, hosts: { fixture: { sigil: 'mage' } } }),
          runCommand,
        }),
      ).toBe(0);

      const evidence = JSON.parse(
        fs.readFileSync(path.join(tmp, 'pentacle-production-build-evidence.json'), 'utf8'),
      );
      expect(evidence.sanitized_endpoint).toBe('wss://control.fixture.internal:7791');
      expect(evidence.config_source).toEqual({ kind: 'local-config', name: 'pentacle.config.local.ts:backend.wsUrl' });
      expect(evidence.bundle.endpoint_match).toBe(true);
      expect(JSON.stringify(evidence)).not.toContain('fixture-secret');
      expect(JSON.stringify(evidence)).not.toContain('pentacle.config.local.ts contents');
      expect(calls.map((argv) => argv.slice(0, 2))).toEqual([
        ['expo', 'export'],
        ['expo', 'run:ios'],
      ]);
      expect(commandOptions.map((options) => options.env)).toEqual([
        { EXPO_PUBLIC_PENTACLE_WS_URL: endpoint },
        { EXPO_PUBLIC_PENTACLE_WS_URL: endpoint },
      ]);
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });

  test('divergent exported endpoint fails before native build', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-endpoint-divergent-'));
    const sourceEndpoint = 'wss://control.fixture.internal:7791/ws';
    const bakedEndpoint = 'wss://stale.fixture.internal:7791/ws';
    const calls: string[][] = [];
    try {
      const runCommand = (argv: string[]) => {
        calls.push(argv);
        if (argv[1] === 'export') {
          fs.mkdirSync(tmp, { recursive: true });
          fs.writeFileSync(path.join(tmp, 'main.jsbundle'), `bundle endpoint ${bakedEndpoint}`);
        }
        return 0;
      };

      expect(() =>
        prodBuild.runIosDevice({
          env: {},
          exportDir: tmp,
          readConfig: () => ({ backend: { wsUrl: sourceEndpoint }, hosts: { fixture: { sigil: 'mage' } } }),
          runCommand,
        }),
      ).toThrow(/endpoint.*match|bundle.*endpoint|diverge/i);
      expect(calls).toHaveLength(1);
      expect(calls[0].slice(0, 2)).toEqual(['expo', 'export']);
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });
});
