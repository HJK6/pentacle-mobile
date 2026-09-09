'use strict';
const os = require('node:os');
const path = require('node:path');
const SETTINGS = Object.freeze(['ONLY_ACTIVE_ARCH=YES', 'COMPILATION_CACHE_ENABLE_CACHING=YES', 'COMPILATION_CACHE_ENABLE_DIAGNOSTIC_REMARKS=YES']);
function buildArguments(workspace, derivedData, bundleId = '') {
  const args = ['xcodebuild', '-workspace', workspace, '-scheme', 'Pentacle', '-configuration', 'Release',
    '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', derivedData, '-jobs', '4',
    `ARCHS=${os.arch() === 'arm64' ? 'arm64' : 'x86_64'}`, `COMPILATION_CACHE_CAS_PATH=${path.join(derivedData, 'CompilationCache.noindex')}`, ...SETTINGS];
  if (bundleId) args.push(`PRODUCT_BUNDLE_IDENTIFIER=${bundleId}`);
  args.push('build');
  return args;
}
module.exports = { SETTINGS, buildArguments };
