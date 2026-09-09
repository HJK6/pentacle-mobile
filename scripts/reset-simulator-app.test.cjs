const assert = require('node:assert/strict');
const test = require('node:test');

const { resetSimulatorApp } = require('./reset-simulator-app.cjs');

function fakeCommand(apps) {
  const calls = [];
  const command = (executable, args, options) => {
    calls.push({ executable, args });
    if (executable === 'xcrun' && args.includes('listapps')) {
      return { status: 0, stdout: 'plist inventory', stderr: '' };
    }
    if (executable === 'plutil') {
      assert.equal(options.input, 'plist inventory');
      return { status: 0, stdout: JSON.stringify(apps), stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { calls, command };
}

test('removes the exact installed bundle before the release install', () => {
  const fake = fakeCommand({ 'com.example.pentacle.mobile': {}, 'com.example.pentacle.mobile.other': {} });
  assert.deepEqual(resetSimulatorApp({
    deviceSetRoot: '/tmp/simulator/Devices',
    udid: 'SIM-1',
    bundleId: 'com.example.pentacle.mobile',
  }, fake.command), { prior_state: 'installed', removed: true });
  assert.deepEqual(fake.calls.at(-1), {
    executable: 'xcrun',
    args: ['simctl', '--set', '/tmp/simulator/Devices', 'uninstall', 'SIM-1', 'com.example.pentacle.mobile'],
  });
});

test('keeps an already-absent exact bundle absent', () => {
  const fake = fakeCommand({ 'com.example.pentacle.mobile.other': {} });
  assert.deepEqual(resetSimulatorApp({
    deviceSetRoot: '/tmp/simulator/Devices',
    udid: 'SIM-1',
    bundleId: 'com.example.pentacle.mobile',
  }, fake.command), { prior_state: 'absent', removed: false });
  assert.equal(fake.calls.some((call) => call.args.includes('uninstall')), false);
});

test('fails closed when installed-app inventory cannot be read', () => {
  assert.throws(() => resetSimulatorApp({
    deviceSetRoot: '/tmp/simulator/Devices',
    udid: 'SIM-1',
    bundleId: 'com.example.pentacle.mobile',
  }, () => ({ status: 1, stdout: '', stderr: 'inventory unavailable' })), /inventory unavailable/);
});
