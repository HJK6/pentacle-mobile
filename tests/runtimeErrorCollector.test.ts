import {
  installHarnessRuntimeErrorCollector,
  resetHarnessRuntimeErrorCollectorForTests,
} from "../src/harness/runtimeErrorCollector";

afterEach(() => resetHarnessRuntimeErrorCollectorForTests());

test("captures console, fatal global errors, and true tracked rejections with run metadata", () => {
  const events: Record<string, unknown>[] = [];
  const consoleObject = { error: jest.fn() };
  let globalHandler: ((error: unknown, fatal?: boolean) => void) | undefined;
  const priorGlobalHandler = jest.fn();
  const rejectionTracking = { enable: jest.fn() };
  const hermesInternal = { enablePromiseRejectionTracker: jest.fn() };
  const priorUnhandled = jest.fn();

  installHarnessRuntimeErrorCollector({
    log: (event) => events.push(event),
    runId: () => "runtime-run-1",
    consoleObject,
    errorUtils: {
      getGlobalHandler: () => priorGlobalHandler,
      setGlobalHandler: (handler) => { globalHandler = handler; },
    },
    rejectionTracking,
    hermesInternal,
    rejectionOptions: { onUnhandled: priorUnhandled },
  });

  consoleObject.error(new Error("console sentinel"));
  globalHandler?.(new Error("fatal sentinel"), true);
  const trackingOptions = hermesInternal.enablePromiseRejectionTracker.mock.calls[0][0] as {
    onUnhandled: (id: number, error: unknown) => void;
  };
  trackingOptions.onUnhandled(7, new Error("rejection sentinel"));

  expect(events).toEqual([
    expect.objectContaining({ source: "console.error", detail: "console sentinel", fatal: false, scenario_run_id: "runtime-run-1" }),
    expect.objectContaining({ source: "uncaught", detail: "fatal sentinel", fatal: true, scenario_run_id: "runtime-run-1" }),
    expect.objectContaining({ source: "unhandledrejection", detail: "rejection sentinel", fatal: false, scenario_run_id: "runtime-run-1" }),
  ]);
  expect(events.every((event) => typeof event.stack === "string" && String(event.stack).length > 0)).toBe(true);
  expect(priorGlobalHandler).toHaveBeenCalledWith(expect.any(Error), true);
  expect(priorUnhandled).toHaveBeenCalledWith(7, expect.any(Error));
  expect(rejectionTracking.enable).not.toHaveBeenCalled();
});

test("bounds runtime-error telemetry before Unified Logging truncation", () => {
  const events: Record<string, unknown>[] = [];
  const consoleObject = { error: jest.fn() };
  const runId = "report-viewer-2f780507b778-1784145615846-runtime-console_error";

  installHarnessRuntimeErrorCollector({
    log: (event) => events.push(event),
    runId: () => runId,
    consoleObject,
  });
  const cases = [
    { detail: "runtime sentinel console_error", stack: `Error: runtime sentinel console_error\n${"    at oversized-frame (main.jsbundle:123:45)\n".repeat(80)}` },
    { detail: "d".repeat(512), stack: "s".repeat(2048) },
    { detail: "\\\n".repeat(256), stack: "\\\n".repeat(1024) },
    { detail: "💥".repeat(256), stack: "🧨".repeat(1024) },
  ];
  for (const item of cases) {
    const error = new Error(item.detail);
    error.stack = item.stack;
    consoleObject.error(error);
  }

  expect(String(events[0].stack)).toContain("runtime sentinel console_error");
  for (const event of events) {
    const serialized = `[TELEMETRY] ${JSON.stringify({
      subsystem: "harness",
      message: "harness:runtime_error",
      bug_ref: "spec_pentacle_mobile_test_migration_and_coverage",
      data: event,
    })}`;
    expect(event.scenario_run_id).toBe(runId);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(900);
  }
});
