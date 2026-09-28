import React from 'react';
import {act, fireEvent, render} from '@testing-library/react-native';
import NotificationCard from '../src/components/NotificationCard';

const mockRpc = jest.fn();
const mockSign = jest.fn();
let mockMetadata: Record<string, string> = {};
jest.mock('../src/services/pentacleStream', () => ({
  resolveNotification: jest.fn(),
  consentConnection: () => ({scope: 'host|phone', host_id: 'host', credential_id: 'phone', generation: 1}),
  sendConsentCommand: (...args: unknown[]) => mockRpc(...args),
}));
jest.mock('../modules/pentacle-consent', () => ({nativeConsentSigner: () => ({
  createKey: async () => ({keyTag: 'owned-native-key', spki: 'AQID'}), signConsent: mockSign,
})}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => mockMetadata[key] || null,
  setItemAsync: async (key: string, value: string) => {mockMetadata[key] = value;},
}));
const offer = {offer_id: 'offer', host_id: 'host', credential_id: 'phone', label: 'My phone',
  issuer: {kind: 'local-admin', identity: 'local-admin'}, state: 'pending', expires_at: Date.now()/1000 + 86400};
const intent = {request_id: 'request', host_id: 'host', action: 'lifecycle.designate', target_stream_id: 'host:lead',
  target_generation: 'generation', expected_revision: 0, requester: {kind: 'seat', identity: 'host:requester', generation: 'g'},
  audience_key_ids: ['key'], display_text: 'Approval requested', state: 'pending', expires_at: Date.now()/1000 + 86400};
function record(producer: string, fields: object) {
  return {notification_id: 'notification', producer, state: 'open', title: '', body: '', severity: 'info', actions: [], ...fields} as any;
}
beforeEach(() => {jest.clearAllMocks(); mockMetadata = {}; mockSign.mockResolvedValue('signature');});

test('setup notification offers an explicit open and does not sign on receipt', () => {
  const ui = render(<NotificationCard notification={record('consent.enrollment.v1', {consent_offer: offer})} />);
  expect(ui.getByText('Set up Approval key?')).toBeTruthy();
  expect(ui.getByText('Open request')).toBeTruthy();
  expect(ui.queryByText(/fingerprint/i)).toBeNull();
  expect(mockRpc).not.toHaveBeenCalled(); expect(mockSign).not.toHaveBeenCalled();
});

test('opening starts setup challenge; Set up signs and stores tuple before send', async () => {
  mockRpc.mockImplementation(async (verb: string) => {
    if (verb === 'consent_key.open') return {offer: {...offer, challenge_id: 'challenge', nonce: 'nonce', challenge_expires_at: Math.floor(Date.now()/1000) + 120}};
    if (verb === 'consent_key.accept') {
      expect(Object.values(mockMetadata).join('')).toContain('owned-native-key');
      expect(Object.values(mockMetadata).join('')).toContain('signature');
      return {offer: {...offer, state: 'accepted', accepted_key_id: 'key', key_state: 'active'},
              receipt: {offer_id: 'offer', host_id: 'host', credential_id: 'phone', key_id: 'key', spki_hash: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81', state: 'active'}};
    }
  });
  const ui = render(<NotificationCard notification={record('consent.enrollment.v1', {consent_offer: offer})} />);
  await act(async () => fireEvent.press(ui.getByText('Open request')));
  expect(mockSign).not.toHaveBeenCalled();
  await act(async () => fireEvent.press(ui.getByText('Set up with Face ID')));
  expect(ui.getByText('Approval key ready')).toBeTruthy();
  expect(mockSign).toHaveBeenCalledTimes(1);
});

test('approval intent cannot approve before explicit open and never opens from render', () => {
  const ui = render(<NotificationCard notification={record('consent.v1', {consent: intent})} />);
  expect(ui.getByText('Open request')).toBeTruthy();
  expect(ui.queryByText('Approve with Face ID')).toBeNull();
  expect(mockRpc).not.toHaveBeenCalled(); expect(mockSign).not.toHaveBeenCalled();
});
