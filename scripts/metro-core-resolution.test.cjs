const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');

function loadConfig() {
  const configPath = require.resolve('../metro.config.js');
  delete require.cache[configPath];
  return require(configPath);
}

test('Metro keeps the shared chat package on the public package boundary', () => {
  const config = loadConfig();
  const outsideWatchFolder = (config.watchFolders || []).some((folder) => {
    const resolved = path.resolve(folder);
    return resolved !== projectRoot && !resolved.startsWith(`${projectRoot}${path.sep}`);
  });
  assert.equal(outsideWatchFolder, false);
  assert.equal(config.resolver.extraNodeModules?.['example-chat-core'], undefined);
});

test('near-name packages use the ordinary resolver path', () => {
  const config = loadConfig();
  const calls = [];
  const fallback = (context, moduleName, platform) => {
    calls.push([context, moduleName, platform]);
    return { type: 'empty' };
  };
  const context = { originModulePath: __filename, resolveRequest: fallback };
  assert.deepEqual(config.resolver.resolveRequest(context, 'example-chat-core-near', 'ios'), { type: 'empty' });
  assert.deepEqual(calls, [[context, 'example-chat-core-near', 'ios']]);
});

test('embedded-debug devtools redirect remains gated and local', () => {
  const previous = process.env.EXAMPLE_E2E_EMBEDDED_DEBUG;
  process.env.EXAMPLE_E2E_EMBEDDED_DEBUG = '1';
  try {
    const config = loadConfig();
    const context = {
      originModulePath: path.join(projectRoot, 'node_modules/expo/src/Expo.fx.tsx'),
      resolveRequest: () => { throw new Error('unexpected fallback'); },
    };
    assert.deepEqual(config.resolver.resolveRequest(context, './async-require/messageSocket', 'ios'), {
      type: 'sourceFile',
      filePath: path.join(projectRoot, 'src/harness/noopDevtoolsMessageSocket.ts'),
    });
  } finally {
    if (previous === undefined) delete process.env.EXAMPLE_E2E_EMBEDDED_DEBUG;
    else process.env.EXAMPLE_E2E_EMBEDDED_DEBUG = previous;
  }
});
