const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { patchPodfile } = require('../plugins/withNativeCompilerPolicy');

const template = "target 'Pentacle' do\n  post_install do |installer|\n    react_native_post_install(\n      installer\n    )\n  end\nend\n";

test('runs the generated policy after React Native and changes only fmt configurations', () => {
  const patched = patchPodfile(template);
  const ruby = `
    require 'json'
    Configuration = Struct.new(:build_settings)
    Target = Struct.new(:name, :build_configurations)
    Project = Struct.new(:targets)
    Installer = Struct.new(:pods_project)
    $targets = ['fmt', 'React-Core', 'Pentacle'].map { |name| Target.new(name, [Configuration.new({})]) }
    def target(*) = yield
    def post_install = yield Installer.new(Project.new($targets))
    def react_native_post_install(installer)
      installer.pods_project.targets.each { |t| t.build_configurations.each { |c| c.build_settings['CLANG_CXX_LANGUAGE_STANDARD'] = 'c++20' } }
    end
    ${patched}
    puts JSON.generate($targets.to_h { |t| [t.name, t.build_configurations.first.build_settings] })
  `;
  const result = spawnSync('/opt/homebrew/opt/ruby/bin/ruby', ['-e', ruby], { encoding: 'utf8', timeout: 10000 });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    fmt: { CLANG_CXX_LANGUAGE_STANDARD: 'c++17' },
    'React-Core': { CLANG_CXX_LANGUAGE_STANDARD: 'c++20' },
    Pentacle: { CLANG_CXX_LANGUAGE_STANDARD: 'c++20' },
  });
});

test('policy is idempotent and preserves other post-install work', () => {
  const source = template.replace('  end\nend', '    # other build policy\n  end\nend');
  const patched = patchPodfile(source);
  expect(patchPodfile(patched)).toBe(patched);
  expect(patched).toContain('# other build policy');
});

test.each(['', "target 'Pentacle' do\nend\n", template + template])('refuses a missing or ambiguous hook', source => {
  expect(() => patchPodfile(source)).toThrow('NATIVE_COMPILER_POLICY_HOOK');
});

test('registered native plugin is part of candidate generation', () => {
  const config = fs.readFileSync(path.join(__dirname, '../app.config.ts'), 'utf8');
  expect(config).toContain("'./plugins/withNativeCompilerPolicy'");
});
