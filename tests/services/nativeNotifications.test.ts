describe('nativeNotifications', () => {
  test('does not load expo-notifications in harness builds', () => {
    process.env.EXPO_PUBLIC_HARNESS = '1';
    jest.resetModules();
    const moduleFactory = jest.fn(() => ({}));
    jest.doMock('expo-notifications', moduleFactory);

    jest.isolateModules(() => {
      const { getNativeNotifications } = require('../../src/services/nativeNotifications');
      expect(getNativeNotifications()).toBeNull();
    });

    expect(moduleFactory).not.toHaveBeenCalled();
    delete process.env.EXPO_PUBLIC_HARNESS;
  });
});
