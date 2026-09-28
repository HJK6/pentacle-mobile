const { withDangerousMod } = require('@expo/config-plugins');
const { withXcodeProject } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const MARKER = 'Pods/.last_build_configuration';
const SENTINEL = '# pentacle-hermes-build-state';
const IOS_DEPLOYMENT_TARGET = '15.0';
const DEPLOYMENT_TARGET_SENTINEL = '# pentacle-ios-deployment-target-floor';

function withHermesBuildState(config) {
  config = withXcodeProject(config, modConfig => {
    const project = modConfig.modResults;
    const target = Object.entries(project.pbxNativeTargetSection()).find(([k, v]) => !k.endsWith('_comment') && String(v.name).replace(/"/g, '') === 'Pentacle');
    if (target && !(target[1].buildPhases || []).some(p => p.comment === 'Verify Hermes runtime identity')) {
      project.addBuildPhase([], 'PBXShellScriptBuildPhase', 'Verify Hermes runtime identity', target[0], { shellPath: '/bin/sh', shellScript: 'set -e\nnode "$SRCROOT/../scripts/verify-hermes-runtime.cjs" "$CONFIGURATION"' });
    }
    return modConfig;
  });
  return withDangerousMod(config, ['ios', async (modConfig) => {
    const podfile = path.join(modConfig.modRequest.platformProjectRoot, 'Podfile');
    // On a non-clean prebuild the Podfile template may not have been written yet
    // when this dangerous mod runs; reading it unconditionally threw ENOENT and
    // aborted the entire prebuild. Skip gracefully — a clean prebuild (which the
    // gate uses) regenerates the Podfile and this mod patches it then.
    if (!fs.existsSync(podfile)) return modConfig;
    let source = fs.readFileSync(podfile, 'utf8');
    const hooks = [];
    if (!source.includes(SENTINEL)) {
      hooks.push(`\n    ${SENTINEL}\n    marker = File.join(Pod::Config.instance.installation_root, '${MARKER}')\n    File.delete(marker) if File.file?(marker)\n`);
    }
    if (!source.includes(DEPLOYMENT_TARGET_SENTINEL)) {
      hooks.push(`\n    ${DEPLOYMENT_TARGET_SENTINEL}\n    minimum_ios_deployment_target = '${IOS_DEPLOYMENT_TARGET}'\n    installer.pods_project.targets.each do |target|\n      target.build_configurations.each do |build_configuration|\n        current_target = build_configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET']\n        if current_target.nil? || Gem::Version.new(current_target.to_s) < Gem::Version.new(minimum_ios_deployment_target)\n          build_configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = minimum_ios_deployment_target\n        end\n      end\n    end\n`);
    }
    if (hooks.length > 0) {
      const anchor = '  end\nend\n';
      const anchorIndex = source.indexOf(anchor);
      if (anchorIndex < 0 || source.indexOf(anchor, anchorIndex + anchor.length) >= 0) {
        throw new Error('Unable to locate unique Podfile post_install hook');
      }
      source = source.slice(0, anchorIndex) + hooks.join('') + source.slice(anchorIndex);
      fs.writeFileSync(podfile, source);
    }
    return modConfig;
  }]);
}

module.exports = withHermesBuildState;
