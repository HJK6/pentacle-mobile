// Tests only a mocked project; never executes an Xcode phase or native build.
describe('unregistered iOS build stamp plugin source', () => {
  function run(target: any, phases: any[] = []) {
    jest.resetModules();
    const addBuildPhase = jest.fn();
    const project = { pbxNativeTargetSection: () => target, addBuildPhase };
    jest.doMock('@expo/config-plugins', () => ({ withXcodeProject: (config: any, mod: any) => mod({ ...config, modResults: project }) }));
    require('../plugins/withIosBuildNumberStamp')({});
    return addBuildPhase;
  }
  test('stamps the named target once and refuses shallow history in generated script', () => {
    const add = run({ ignored_comment: 'Pentacle', example: { name: '"Pentacle"', buildPhases: [] } });
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][3]).toBe('example');
    const script = add.mock.calls[0][4].shellScript;
    expect(script).toContain('git rev-parse --is-shallow-repository');
    expect(script).toContain('git rev-list --count HEAD');
    expect(script).toContain('Set :CFBundleVersion');
  });
  test('does not duplicate an existing phase', () => {
    expect(run({ example: { name: 'Pentacle', buildPhases: [{ comment: 'Stamp CFBundleVersion from git' }] } })).not.toHaveBeenCalled();
  });
  test('rejects a project without the required target', () => {
    expect(() => run({ example: { name: 'Other', buildPhases: [] } })).toThrow('Could not find iOS native target');
  });
});
