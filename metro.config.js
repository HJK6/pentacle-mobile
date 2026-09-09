// Public Metro configuration.
//
// The shared chat model is resolved through the normal package resolver. A
// published or vendored package can therefore be used without watching an
// absolute path outside the application project.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);

config.resolver = config.resolver ?? {};
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    process.env.EXAMPLE_E2E_EMBEDDED_DEBUG === '1' &&
    moduleName === './async-require/messageSocket' &&
    String(context.originModulePath || '').includes(`${path.sep}node_modules${path.sep}expo${path.sep}src${path.sep}Expo.fx`)
  ) {
    return {
      type: 'sourceFile',
      filePath: path.resolve(projectRoot, 'src/harness/noopDevtoolsMessageSocket.ts'),
    };
  }
  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
