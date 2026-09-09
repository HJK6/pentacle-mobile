import Constants from 'expo-constants';
import { loadDashboardHubRuntime } from '../../../src/features/dashboards/dashboardHubRuntime';
import { getPentacleDeviceToken } from '../../../src/services/deviceCredentialStore';

jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));
jest.mock('../../../src/config/local', () => ({ getBackendWsUrl: () => 'ws://10.0.0.0:7791/ws' }));
jest.mock('../../../src/services/deviceCredentialStore', () => ({
  getPentacleDeviceToken: jest.fn(),
  setPentacleDeviceToken: jest.fn(),
}));
jest.mock('../../../src/utils/harnessRuntime', () => ({ getParam: jest.fn() }));

test('derives the sample Hub port and reuses the test device credential', async () => {
  (getPentacleDeviceToken as jest.MockedFunction<typeof getPentacleDeviceToken>).mockResolvedValue('TEST');
  await expect(loadDashboardHubRuntime()).resolves.toEqual({
    url: 'ws://10.0.0.0:7781',
    controlUrl: 'http://10.0.0.0:7781',
    deviceToken: 'TEST',
  });
});

test('prefers an explicit public Hub URL', async () => {
  (Constants.expoConfig!.extra as Record<string, unknown>).dashboardHubUrl = 'ws://example.local:9000/';
  (getPentacleDeviceToken as jest.MockedFunction<typeof getPentacleDeviceToken>).mockResolvedValue('TEST');
  await expect(loadDashboardHubRuntime()).resolves.toMatchObject({
    url: 'ws://example.local:9000',
    controlUrl: 'http://example.local:9000',
  });
});

