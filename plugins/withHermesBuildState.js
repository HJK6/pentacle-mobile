const { withDangerousMod } = require('@expo/config-plugins');
const { withXcodeProject } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const MARKER = 'Pods/.last_build_configuration';
const SENTINEL = '# pentacle-hermes-build-state';

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
    if (!source.includes(SENTINEL)) {
      const hook = `\n    ${SENTINEL}\n    marker = File.join(Pod::Config.instance.installation_root, '${MARKER}')\n    File.delete(marker) if File.file?(marker)\n`;
      const anchor = '    )\n  end\nend\n';
      if (!source.includes(anchor)) throw new Error('Unable to locate Podfile post_install hook');
      source = source.replace(anchor, `    )${hook}  end\nend\n`);
      fs.writeFileSync(podfile, source);
    }
    return modConfig;
  }]);
}

module.exports = withHermesBuildState;
