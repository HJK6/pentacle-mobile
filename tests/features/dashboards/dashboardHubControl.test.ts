import { mutateForeclosureGate } from '../../../src/features/dashboards/dashboardHubControl';
import { loadDashboardHubRuntime } from '../../../src/features/dashboards/dashboardHubRuntime';
import { gateContract } from '../../fixtures/publicDashboardFixtures';

jest.mock('../../../src/features/dashboards/dashboardHubRuntime', () => ({ loadDashboardHubRuntime: jest.fn() }));

const mockRuntime = loadDashboardHubRuntime as jest.MockedFunction<typeof loadDashboardHubRuntime>;
const success = {
  ok: true as const,
  batch: 'batch-1',
  gate: 'open' as const,
  setting: 'auto_submit_skipmatrix',
  changed: true,
  device_id: 'phone-1',
  updated_at: '2026-07-17T08:00:00Z',
};

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

test('control error fixtures are independently synthetic', () => {
  expect(gateContract.source).toBe('independently synthetic public test cases');
  expect(gateContract.cases.map(entry => entry.response.status)).toEqual([400, 401, 403, 409, 500]);
});

test('uses the per-device write token and stable control contract', async () => {
  mockRuntime.mockResolvedValue({
    url: 'ws://hub:7780',
    controlUrl: 'http://hub:7780',
    deviceToken: 'device-write-token',
  });
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => success,
  } as Response);
  await expect(mutateForeclosureGate({ batch: 'batch-1', gate: 'open' })).resolves.toEqual(success);
  expect(fetchMock).toHaveBeenCalledWith('http://hub:7780/control/batch-gate', expect.objectContaining({
    method: 'POST',
    headers: expect.objectContaining({ Authorization: 'Bearer device-write-token' }),
    body: JSON.stringify({ batch: 'batch-1', gate: 'open' }),
  }));
});

test('fails closed when the device has no write enrollment', async () => {
  mockRuntime.mockResolvedValue({ url: 'ws://hub:7780', controlUrl: 'http://hub:7780', deviceToken: '' });
  const fetchMock = jest.spyOn(globalThis, 'fetch');
  await expect(mutateForeclosureGate({ batch: 'batch-1', gate: 'closed' })).resolves.toEqual({
    ok: false,
    error: 'Gate control is not enrolled on this device',
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

test('preserves an idempotent changed false response for snapshot reconciliation', async () => {
  mockRuntime.mockResolvedValue({ url: 'ws://hub:7780', controlUrl: 'http://hub:7780', deviceToken: 'device-token' });
  jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ...success, changed: false }),
  } as Response);
  await expect(mutateForeclosureGate({ batch: 'batch-1', gate: 'open' })).resolves.toMatchObject({ ok: true, changed: false });
});

test('returns flat contract errors and rejects malformed success payloads', async () => {
  mockRuntime.mockResolvedValue({ url: 'ws://hub:7780', controlUrl: 'http://hub:7780', deviceToken: 'device-token' });
  const fetchMock = jest.spyOn(globalThis, 'fetch');
  for (const entry of gateContract.cases.filter((candidate) => candidate.response.status >= 400)) {
    const body = entry.response.body as { error: string };
    fetchMock.mockResolvedValueOnce({ ok: false, status: entry.response.status, json: async () => body } as Response);
    await expect(mutateForeclosureGate({ batch: 'batch-1', gate: 'open' })).resolves.toEqual({ ok: false, error: body.error });
  }
  fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) } as Response);
  await expect(mutateForeclosureGate({ batch: 'batch-1', gate: 'open' })).resolves.toEqual({ ok: false, error: 'Gate control returned an invalid response' });
  expect(fetchMock).toHaveBeenCalledTimes(gateContract.cases.filter((candidate) => candidate.response.status >= 400).length + 1);
});
