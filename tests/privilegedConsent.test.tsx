import React from 'react';
import {act, fireEvent, render} from '@testing-library/react-native';
import {toByteArray} from 'base64-js';
import ConsentCard from '../src/components/ConsentCard';
import {approveConsent, consentError, enrollApprovalKey, framedEnrollment, type ConsentChallenge} from '../src/services/privilegedConsent';

let mockReadiness = true;
let mockConnection = 1;
let mockMetadata: string | null = null;
const mockSign = jest.fn().mockResolvedValue('signed-tuple');
const mockCreate = jest.fn().mockResolvedValue({keyTag: 'local-key', spki: 'public-spki'});
const mockRpc = jest.fn();
jest.mock('../modules/pentacle-consent', () => ({nativeConsentSigner: () => ({createKey: mockCreate, signConsent: mockSign})}));
jest.mock('../src/services/pentacleStream', () => ({useConsentEnrollmentReady: () => mockReadiness, consentEnrollmentConnection: () => mockReadiness ? mockConnection : null, sendConsentCommand: (...args: unknown[]) => mockRpc(...args)}));
jest.mock('expo-secure-store', () => ({getItemAsync: async () => mockMetadata, setItemAsync: async (_key: string, value: string) => {mockMetadata = value;}}));

const challenge: ConsentChallenge = {
  challenge_id: 'exact-challenge', action: 'lifecycle.designate', target_stream_id: 'hosta:bart',
  target_generation: 'exact-generation', expected_revision: 0,
  requester: {kind: 'seat', identity: 'hosta:requester', generation: 'requester-generation'},
  audience_key_ids: ['enrolled-key'], audience_hash: 'audience-hash',
  display_text: 'approve on: Paired phone', expires_at: Date.now()/1000 + 120,
  state: 'pending', challenge_bytes: 'daemon-canonical-bytes',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockReadiness = true;
  mockConnection = 1;
  mockMetadata = JSON.stringify([{key_id: 'enrolled-key', keyTag: 'local-key', fingerprint: 'a'.repeat(64)}]);
  mockSign.mockResolvedValue('signed-tuple');
  mockRpc.mockImplementation(async (verb: string) => {
    if (verb === 'consent_key.prepare') return {code_hash: 'code-hash', credential_id: 'credential', nonce: 'nonce'};
    if (verb === 'consent_key.enroll') return {key_id: 'new-key', fingerprint: 'b'.repeat(64)};
    return {type: verb + '.ok'};
  });
});

test('card displays bound action, target, generation, revision, requester and audience', async () => {
  const ui = render(<ConsentCard challenge={challenge} />);
  expect(ui.getByText('lifecycle.designate')).toBeTruthy();
  expect(ui.getByText('Target: hosta:bart')).toBeTruthy();
  expect(ui.getByText('Generation: exact-generation')).toBeTruthy();
  expect(ui.getByText('Revision: 0')).toBeTruthy();
  expect(ui.getByText('Requester: seat hosta:requester requester-generation')).toBeTruthy();
  expect(ui.getByText('approve on: Paired phone')).toBeTruthy();
  await act(async () => fireEvent.press(ui.getByTestId('consent-approve')));
  expect(mockSign).toHaveBeenCalledWith('local-key', 'daemon-canonical-bytes');
  expect(mockRpc).toHaveBeenCalledWith('consent.approve', {challenge_id: challenge.challenge_id, key_id: 'enrolled-key', signature: 'signed-tuple'});
});

test('deny sends only the challenge id and never invokes the signer', async () => {
  const ui = render(<ConsentCard challenge={challenge} />);
  await act(async () => fireEvent.press(ui.getByTestId('consent-deny')));
  expect(mockSign).not.toHaveBeenCalled();
  expect(mockRpc).toHaveBeenCalledWith('consent.deny', {challenge_id: challenge.challenge_id});
});

test('explicit retry reuses the identical tuple after an ambiguous transport failure', async () => {
  const ch = {...challenge, challenge_id: 'retry-challenge'};
  mockRpc.mockRejectedValueOnce(new Error('disconnected'));
  await expect(approveConsent(ch)).rejects.toThrow('disconnected');
  await approveConsent(ch);
  expect(mockSign).toHaveBeenCalledTimes(1);
  expect(mockRpc.mock.calls[0]).toEqual(mockRpc.mock.calls[1]);
});

test('expired approval never signs or sends', async () => {
  await expect(approveConsent({...challenge, expires_at: 1})).rejects.toThrow('expired');
  expect(mockSign).not.toHaveBeenCalled();
  expect(mockRpc).not.toHaveBeenCalled();
});

test('enrollment binds transcript and retains prior local key', async () => {
  const key = await enrollApprovalKey('ABCDEFGH');
  expect(mockSign).toHaveBeenCalledWith('local-key', framedEnrollment(['code-hash', 'credential', 'public-spki', 'nonce']));
  expect(key.fingerprint).toBe('b'.repeat(64));
  expect(JSON.parse(mockMetadata!)).toHaveLength(2);
});

test('framing uses unsigned big-endian byte lengths', () => {
  const bytes = toByteArray(framedEnrollment(['é']));
  const domainLength = new DataView(bytes.buffer).getUint32(0, false);
  expect(domainLength).toBe(22);
  expect(new DataView(bytes.buffer).getUint32(4 + domainLength, false)).toBe(2);
});

test.each([
  ['key_invalidated', 'Approval key needs re-enrollment.'],
  ['biometry_lockout', 'Face ID is locked. Unlock Face ID, then retry.'],
  ['cancelled', 'Face ID approval canceled.'],
])('native error %s maps to actionable text', (code, expected) => {
  expect(consentError(new Error(code))).toBe(expected);
});

 test('a fresh challenge requires a fresh signature', async () => {
  await approveConsent({...challenge, challenge_id:'fresh-1'});
  await approveConsent({...challenge, challenge_id:'fresh-2'});
  expect(mockSign).toHaveBeenCalledTimes(2);
 });

 test('enrollment stops if the host changes while Face ID signs', async () => {
  mockSign.mockImplementationOnce(async () => { mockConnection = 2; return 'signed-tuple'; });
  await expect(enrollApprovalKey('ABCDEFGH')).rejects.toThrow('connection changed');
  expect(mockRpc.mock.calls.map(([verb]) => verb)).toEqual(['consent_key.prepare']);
 });
 test('only an exact verified approval receipt marks the local key active', async () => {
  const ch = {...challenge, challenge_id:'receipt-challenge'};
  mockMetadata = JSON.stringify([{key_id:'enrolled-key',keyTag:'local-key',fingerprint:'a'.repeat(64),state:'pending_confirm'}]);
  mockRpc.mockResolvedValueOnce({receipt:{consent_id:'wrong'},challenge:{challenge_id:ch.challenge_id,state:'approved',approved_by_key_id:'enrolled-key'}});
  await approveConsent(ch);
  expect(JSON.parse(mockMetadata!)[0].state).toBe('pending_confirm');
  mockRpc.mockResolvedValueOnce({receipt:{consent_id:ch.challenge_id},challenge:{challenge_id:ch.challenge_id,state:'approved',approved_by_key_id:'enrolled-key'}});
  await approveConsent(ch);
  expect(JSON.parse(mockMetadata!)[0].state).toBe('active');
 });
 test.each([
  ['consent_key_revoked', 'revoked'], ['consent_key_invalid','invalidated'],
  ['key_invalidated','invalidated'], ['biometry_unavailable','invalidated'],
  ['cancelled', 'pending_confirm'], ['disconnected','pending_confirm'],
 ])('only explicit refusal/invalidation changes saved state: %s', async (code, state) => {
  mockMetadata = JSON.stringify([{key_id:'enrolled-key',keyTag:'local-key',fingerprint:'a'.repeat(64),state:'pending_confirm'}]);
  const ch = {...challenge,challenge_id:'error-'+code};
  if (['key_invalidated','biometry_unavailable','cancelled'].includes(code)) mockSign.mockRejectedValueOnce(new Error(code));
  else mockRpc.mockRejectedValueOnce(new Error(code));
  await expect(approveConsent(ch)).rejects.toThrow(code);
  expect(JSON.parse(mockMetadata!)[0].state).toBe(state);
 });

afterEach(async () => { await act(async () => {}); });
