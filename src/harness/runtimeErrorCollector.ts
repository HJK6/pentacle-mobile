type ErrorUtilsLike = {
  getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void);
  setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
};

type CollectorDependencies = {
  log: (payload: Record<string, unknown>) => void;
  runId: () => string;
  consoleObject?: Pick<Console, 'error'>;
  errorUtils?: ErrorUtilsLike;
  rejectionTracking?: { enable: (options: Record<string, unknown>) => void };
  rejectionOptions?: Record<string, unknown>;
  hermesInternal?: { enablePromiseRejectionTracker?: (options: Record<string, unknown>) => void };
};

let installed = false;

const MAX_RUNTIME_ERROR_DATA_BYTES = 720;
const MAX_ERROR_DETAIL_JSON_BYTES = 192;

function utf8Bytes(value: string) {
  let bytes = 0;
  for (const char of value) {
    const point = char.codePointAt(0) || 0;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function fitJsonString(value: string, byteBudget: number) {
  let fitted = '';
  let encodedBytes = 0;
  for (const char of value) {
    const encoded = JSON.stringify(char).slice(1, -1);
    const charBytes = utf8Bytes(encoded);
    if (encodedBytes + charBytes > byteBudget) break;
    fitted += char;
    encodedBytes += charBytes;
  }
  return { value: fitted, encodedBytes };
}

function errorText(error: unknown) {
  if (error instanceof Error) {
    return { detail: error.message, stack: error.stack || '' };
  }
  return { detail: String(error), stack: '' };
}

function errorFields(error: unknown, identity: Record<string, unknown>) {
  const raw = errorText(error);
  const emptyPayloadBytes = utf8Bytes(JSON.stringify({ ...identity, detail: '', stack: '' }));
  let remaining = Math.max(0, MAX_RUNTIME_ERROR_DATA_BYTES - emptyPayloadBytes);
  const detail = fitJsonString(raw.detail, Math.min(remaining, MAX_ERROR_DETAIL_JSON_BYTES));
  remaining -= detail.encodedBytes;
  const stack = fitJsonString(raw.stack, remaining);
  return { detail: detail.value, stack: stack.value };
}

export function installHarnessRuntimeErrorCollector(dependencies: CollectorDependencies) {
  if (installed) return;
  installed = true;
  const consoleObject = dependencies.consoleObject || console;
  const errorUtils = dependencies.errorUtils || (globalThis as unknown as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
  const report = (source: string, error: unknown, fatal = false) => {
    const identity = {
      source,
      fatal,
      scenario_run_id: dependencies.runId(),
    };
    dependencies.log({
      ...identity,
      ...errorFields(error, identity),
    });
  };

  const originalConsoleError = consoleObject.error.bind(consoleObject);
  consoleObject.error = (...args: unknown[]) => {
    originalConsoleError(...args);
    const error = args.find((value) => value instanceof Error) || args.map(String).join(' ');
    report('console.error', error, false);
  };

  if (errorUtils?.setGlobalHandler) {
    const prior = errorUtils.getGlobalHandler?.();
    errorUtils.setGlobalHandler((error, isFatal = false) => {
      report('uncaught', error, isFatal);
      prior?.(error, isFatal);
    });
  }

  if (dependencies.rejectionTracking || dependencies.hermesInternal?.enablePromiseRejectionTracker) {
    const priorOptions = dependencies.rejectionOptions || {};
    const priorUnhandled = priorOptions.onUnhandled as ((id: number, error: unknown) => void) | undefined;
    const options = {
      ...priorOptions,
      allRejections: true,
      onUnhandled: (id: number, error: unknown) => {
        report('unhandledrejection', error, false);
        priorUnhandled?.(id, error);
      },
    };
    if (dependencies.hermesInternal?.enablePromiseRejectionTracker) {
      dependencies.hermesInternal.enablePromiseRejectionTracker(options);
    } else {
      dependencies.rejectionTracking?.enable(options);
    }
  }
}

export function resetHarnessRuntimeErrorCollectorForTests() {
  installed = false;
}
