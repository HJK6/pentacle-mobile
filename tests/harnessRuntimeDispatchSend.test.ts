/**
 * Unit tests for harnessRuntime.registerSendHandler / dispatchSend.
 *
 * Spec: public-test-spec Stage 2
 * §"Compose-driving plumbing".
 *
 * The functions are gated on `EXPO_PUBLIC_HARNESS === '1'`; tests below
 * set the flag before requiring the module and isolate via `jest.resetModules`
 * so we exercise both the harness path and the production short-circuit.
 */
import type * as HarnessRuntimeModule from '../src/utils/harnessRuntime';

describe('harnessRuntime.registerSendHandler / dispatchSend — harness flag ON', () => {
  let runtime: typeof HarnessRuntimeModule;

  beforeEach(() => {
    process.env.EXPO_PUBLIC_HARNESS = '1';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    runtime = require('../src/utils/harnessRuntime') as typeof HarnessRuntimeModule;
    runtime.__resetSendHandlersForTests();
  });

  afterEach(() => {
    delete process.env.EXPO_PUBLIC_HARNESS;
  });

  test('registers a handler and dispatches text through it', async () => {
    const fn = jest.fn(async (_text) => undefined);
    runtime.registerSendHandler('hostc:codex:alpha', fn);

    const result = await runtime.dispatchSend('hostc:codex:alpha', 'hello world');

    expect(result).toEqual({ status: 'ok' });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('hello world');
  });

  test('scopes handlers per stream_id', async () => {
    const hostCFn = jest.fn(async (_text) => undefined);
    const hostAFn = jest.fn(async (_text) => undefined);
    runtime.registerSendHandler('hostc:codex:one', hostCFn);
    runtime.registerSendHandler('hosta:claude:two', hostAFn);

    const hostCResult = await runtime.dispatchSend('hostc:codex:one', 'msg-hostc');
    const hostAResult = await runtime.dispatchSend('hosta:claude:two', 'msg-hosta');

    expect(hostCResult).toEqual({ status: 'ok' });
    expect(hostAResult).toEqual({ status: 'ok' });
    expect(hostCFn).toHaveBeenCalledWith('msg-hostc');
    expect(hostCFn).toHaveBeenCalledTimes(1);
    expect(hostAFn).toHaveBeenCalledWith('msg-hosta');
    expect(hostAFn).toHaveBeenCalledTimes(1);
  });

  test('dispatchSend awaits the handler (async resolution)', async () => {
    let resolveSend: (() => void) | null = null;
    const fn = jest.fn(
      (_text) =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    runtime.registerSendHandler('hostc:codex:alpha', fn);

    const pending = runtime.dispatchSend('hostc:codex:alpha', 'eventual');

    // Handler called immediately, but dispatchSend has not yet resolved.
    expect(fn).toHaveBeenCalledTimes(1);
    let settled = false;
    pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveSend!();
    await expect(pending).resolves.toEqual({ status: 'ok' });
  });

  test('unregister via returned function — subsequent dispatch returns no_handler', async () => {
    const fn = jest.fn(async (_text) => undefined);
    const unregister = runtime.registerSendHandler('hostc:codex:alpha', fn);

    const first = await runtime.dispatchSend('hostc:codex:alpha', 'first');
    expect(first).toEqual({ status: 'ok' });

    unregister();

    const second = await runtime.dispatchSend('hostc:codex:alpha', 'second');
    expect(second).toEqual({ status: 'no_handler' });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('first');
  });

  test('dispatchSend returns no_handler for an unknown stream_id', async () => {
    const result = await runtime.dispatchSend('hostc:codex:never-registered', 'lost');
    expect(result).toEqual({ status: 'no_handler' });
  });

  test('LIFO-safe unregister: stale unregister does not wipe a newer handler', async () => {
    const oldFn = jest.fn(async (_text) => undefined);
    const newFn = jest.fn(async (_text) => undefined);

    const unregisterOld = runtime.registerSendHandler('hostc:codex:alpha', oldFn);
    runtime.registerSendHandler('hostc:codex:alpha', newFn);
    unregisterOld(); // should be a no-op since newFn replaced oldFn

    const result = await runtime.dispatchSend('hostc:codex:alpha', 'fresh');
    expect(result).toEqual({ status: 'ok' });
    expect(newFn).toHaveBeenCalledWith('fresh');
    expect(oldFn).not.toHaveBeenCalled();
  });

  test('reset() clears all registered handlers', async () => {
    const fn = jest.fn(async (_text) => undefined);
    runtime.registerSendHandler('hostc:codex:alpha', fn);
    runtime.reset();

    const result = await runtime.dispatchSend('hostc:codex:alpha', 'after-reset');
    expect(result).toEqual({ status: 'no_handler' });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('harnessRuntime.registerSendHandler / dispatchSend — production flag OFF', () => {
  let runtime: typeof HarnessRuntimeModule;

  beforeEach(() => {
    delete process.env.EXPO_PUBLIC_HARNESS;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    runtime = require('../src/utils/harnessRuntime') as typeof HarnessRuntimeModule;
  });

  test('registerSendHandler is a no-op and returns a no-op unregister', async () => {
    const fn = jest.fn(async (_text) => undefined);

    const unregister = runtime.registerSendHandler('hostc:codex:alpha', fn);
    expect(typeof unregister).toBe('function');

    // The unregister is a no-op; calling it must not throw.
    expect(() => unregister()).not.toThrow();

    const result = await runtime.dispatchSend('hostc:codex:alpha', 'prod');
    expect(result).toEqual({ status: 'no_handler' });
    expect(fn).not.toHaveBeenCalled();
  });

  test('dispatchSend returns no_handler without invoking any handler under HARNESS=0', async () => {
    process.env.EXPO_PUBLIC_HARNESS = '0';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const offRuntime = require('../src/utils/harnessRuntime') as typeof HarnessRuntimeModule;

    const fn = jest.fn(async (_text) => undefined);
    offRuntime.registerSendHandler('hostc:codex:alpha', fn);
    const result = await offRuntime.dispatchSend('hostc:codex:alpha', 'off');

    expect(result).toEqual({ status: 'no_handler' });
    expect(fn).not.toHaveBeenCalled();
    delete process.env.EXPO_PUBLIC_HARNESS;
  });
});

