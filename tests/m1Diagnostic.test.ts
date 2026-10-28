const mockLog = jest.fn();
const mockArmed = jest.fn();
jest.mock('pentacle-chat-core', () => ({ logTelemetry: (...args: unknown[]) => mockLog(...args) }));
jest.mock('../src/utils/harnessRuntime', () => ({ isArmed: () => mockArmed() }));

describe('M1 diagnostic telemetry', () => {
  const original = process.env.EXPO_PUBLIC_HARNESS;
  afterEach(() => { process.env.EXPO_PUBLIC_HARNESS = original; jest.resetModules(); mockLog.mockReset(); mockArmed.mockReset(); });
  test('is inert without the harness build flag and when unarmed', () => {
    process.env.EXPO_PUBLIC_HARNESS = '0'; mockArmed.mockReturnValue(true);
    require('../src/utils/m1Diagnostic').m1Diagnostic('test', { origin: 'cancel' });
    expect(mockLog).not.toHaveBeenCalled();
    process.env.EXPO_PUBLIC_HARNESS = '1'; mockArmed.mockReturnValue(false);
    require('../src/utils/m1Diagnostic').m1Diagnostic('test', { origin: 'cancel' });
    expect(mockLog).not.toHaveBeenCalled();
  });
  test('emits named origin, time and no draft text when armed', () => {
    process.env.EXPO_PUBLIC_HARNESS = '1'; mockArmed.mockReturnValue(true);
    require('../src/utils/m1Diagnostic').m1Diagnostic('close_request', { origin: 'cancel', stream_id: 'mock' });
    expect(mockLog).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({kind: 'm1_diagnostic_close_request', origin: 'cancel', stream_id: 'mock', timestamp_emitter_wall: expect.any(Number)}));
  });
});
