const { withPodfile } = require('@expo/config-plugins');

const POLICY = `    # pentacle-fmt-compiler-policy
    installer.pods_project.targets.each do |target|
      next unless target.name == 'fmt'
      target.build_configurations.each do |configuration|
        configuration.build_settings['CLANG_CXX_LANGUAGE_STANDARD'] = 'c++17'
      end
    end
`;

function patchPodfile(source) {
  if (source.includes(POLICY)) return source;
  const hook = '  post_install do |installer|\n';
  const start = source.indexOf(hook);
  const end = source.indexOf('  end\nend', start);
  if (start < 0 || end < 0 || source.indexOf(hook, start + hook.length) >= 0
      || source.includes('# pentacle-fmt-compiler-policy')) {
    throw new Error('NATIVE_COMPILER_POLICY_HOOK');
  }
  return source.slice(0, end) + POLICY + source.slice(end);
}

module.exports = config => withPodfile(config, mod => {
  mod.modResults.contents = patchPodfile(mod.modResults.contents);
  return mod;
});
module.exports.patchPodfile = patchPodfile;
