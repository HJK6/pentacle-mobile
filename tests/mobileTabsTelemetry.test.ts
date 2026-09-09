import {
  logFocusedTab,
  logMobileTabsTelemetry,
  logTabPressed,
} from '../src/services/mobileTabsTelemetry';

afterEach(() => {
  delete (globalThis as { nativeLoggingHook?: unknown }).nativeLoggingHook;
  jest.restoreAllMocks();
});

test('mobile tab telemetry prefers the native hook and preserves focused/pressed data', () => {
  const nativeLoggingHook = jest.fn();
  (globalThis as { nativeLoggingHook?: (message: string, level: number) => void }).nativeLoggingHook = nativeLoggingHook;
  logFocusedTab('settings');
  logTabPressed('chats');
  expect(nativeLoggingHook).toHaveBeenCalledTimes(2);
  expect(nativeLoggingHook.mock.calls[0]?.[0]).toContain('"message":"tabs:screen_focused"');
  expect(nativeLoggingHook.mock.calls[0]?.[0]).toContain('"tab":"settings"');
  expect(nativeLoggingHook.mock.calls[1]?.[0]).toContain('"message":"tabs:tab_pressed"');
  expect(nativeLoggingHook.mock.calls[1]?.[1]).toBe(2);
});

test('accepts dashboards as a focused and pressed tab', () => {
  const nativeLoggingHook = jest.fn();
  (globalThis as { nativeLoggingHook?: (message: string, level: number) => void }).nativeLoggingHook = nativeLoggingHook;
  logFocusedTab('dashboards');
  logTabPressed('dashboards');
  expect(nativeLoggingHook.mock.calls.map((call) => call[0]).join('\n')).toContain('"tab":"dashboards"');
});

test('mobile tab telemetry uses console fallback and safe defaults without a native hook', () => {
  const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  logMobileTabsTelemetry('' as never);
  expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"subsystem":"tabs"'));
  expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"data":{}'));
});
