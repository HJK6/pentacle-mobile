const { withXcodeProject } = require('@expo/config-plugins');

const PHASE_NAME = 'Stamp CFBundleVersion from git';
const TARGET_NAME = 'Pentacle';

const shellScript = `set -e
REPO="$SRCROOT/.."
if [ "$(cd "$REPO" && git rev-parse --is-shallow-repository)" = "true" ]; then
  echo "error: shallow clone - run 'git fetch --unshallow' before building" >&2; exit 1
fi
N="$(cd "$REPO" && git rev-list --count HEAD)"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $N" "\${TARGET_BUILD_DIR}/\${INFOPLIST_PATH}"
echo "Stamped CFBundleVersion=$N"`;

function unquote(value) {
  return typeof value === 'string' ? value.replace(/^"|"$/g, '') : value;
}

function findNativeTarget(project, targetName) {
  const nativeTargets = project.pbxNativeTargetSection();
  const targetEntry = Object.entries(nativeTargets).find(
    ([key, target]) => !key.endsWith('_comment') && unquote(target.name) === targetName,
  );

  if (!targetEntry) {
    throw new Error(`Could not find iOS native target "${targetName}"`);
  }

  return targetEntry;
}

function hasBuildPhase(project, target, phaseName) {
  const buildPhases = target.buildPhases || [];
  return buildPhases.some((phase) => phase.comment === phaseName);
}

function withIosBuildNumberStamp(config) {
  return withXcodeProject(config, (modConfig) => {
    const project = modConfig.modResults;
    const [targetUuid, target] = findNativeTarget(project, TARGET_NAME);

    if (!hasBuildPhase(project, target, PHASE_NAME)) {
      project.addBuildPhase([], 'PBXShellScriptBuildPhase', PHASE_NAME, targetUuid, {
        shellPath: '/bin/sh',
        shellScript,
      });
    }

    return modConfig;
  });
}

module.exports = withIosBuildNumberStamp;
