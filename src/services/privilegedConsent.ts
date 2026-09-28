import * as SecureStore from 'expo-secure-store';
import { fromByteArray } from 'base64-js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { nativeConsentSigner } from '../../modules/pentacle-consent';
import { consentEnrollmentConnection, sendConsentCommand } from './pentacleStream';

export type ConsentChallenge = {
  challenge_id: string;
  action: 'lifecycle.designate' | 'lifecycle.revoke';
  target_stream_id: string;
  target_generation: string;
  expected_revision: number;
  requester: { kind: string; identity: string; generation: string };
  audience_key_ids: string[];
  audience_hash: string;
  display_text: string;
  expires_at: number;
  state: string;
  challenge_bytes: string;
};
export type LocalKey = { key_id: string; keyTag: string; fingerprint: string; state?: 'pending_confirm' | 'active' | 'revoked' | 'invalidated' };
const METADATA = 'pentacle-consent-key-metadata-v1';

export function consentTelemetry(event: string, data: Record<string, unknown> = {}) {
  const line = `[TELEMETRY] ${JSON.stringify({
    subsystem: 'consent', message: `consent.${event}`,
    bug_ref: 'mobile_faceid_privileged_consent_2026_09', data,
  })}`;
  const nativeLoggingHook = (globalThis as unknown as {
    nativeLoggingHook?: (message: string, level: number) => void;
  }).nativeLoggingHook;
  if (typeof nativeLoggingHook === 'function') {
    nativeLoggingHook(line, 2);
  } else {
    console.log(line);
  }
}

export function consentError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('key_invalidated')) return 'Approval key needs re-enrollment.';
  if (message.includes('biometry_lockout')) return 'Face ID is locked. Unlock Face ID, then retry.';
  if (message.includes('cancelled')) return 'Face ID approval canceled.';
  if (message.includes('biometry_unavailable') || message.includes('face_id_required')) return 'Face ID is required for this approval.';
  return message;
}

export function framedEnrollment(fields: string[]): string {
  const parts = ['pentacle-consent-enrol', ...fields].map(utf8ToBytes);
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + 4 + part.length, 0));
  const view = new DataView(bytes.buffer);
  let offset = 0;
  parts.forEach((part) => {
    view.setUint32(offset, part.length, false);
    bytes.set(part, offset + 4);
    offset += 4 + part.length;
  });
  return fromByteArray(bytes);
}

export async function localApprovalKeys(): Promise<LocalKey[]> {
  const stored = await SecureStore.getItemAsync(METADATA);
  return stored ? JSON.parse(stored) as LocalKey[] : [];
}

const keyListeners = new Set<() => void>();
export function subscribeApprovalKeys(listener: () => void) {
  keyListeners.add(listener);
  return () => { keyListeners.delete(listener); };
}
async function saveKeys(keys: LocalKey[]) {
  await SecureStore.setItemAsync(METADATA, JSON.stringify(keys));
  keyListeners.forEach((listener) => listener());
}
async function markKey(keyId: string, state: LocalKey['state']) {
  await saveKeys((await localApprovalKeys()).map((key) => key.key_id === keyId ? {...key, state} : key));
}
function keyFailure(error: unknown): LocalKey['state'] | undefined {
  const code = error instanceof Error ? error.message : '';
  if (code === 'consent_key_revoked') return 'revoked';
  if (['consent_key_invalid', 'key_invalidated', 'biometry_unavailable', 'face_id_required'].includes(code)) return 'invalidated';
  return undefined;
}

export async function enrollApprovalKey(code: string): Promise<LocalKey> {
  const connection = consentEnrollmentConnection();
  const requireSameConnection = () => {
    if (connection === null || consentEnrollmentConnection() !== connection) throw new Error('Host connection changed. Wait for readiness and enter a new host code.');
  };
  requireSameConnection();
  const prepared = await sendConsentCommand<{code_hash: string; credential_id: string; nonce: string}>('consent_key.prepare', { code });
  requireSameConnection();
  const signer = nativeConsentSigner();
  const generated = await signer.createKey();
  const signature = await signer.signConsent(generated.keyTag,
    framedEnrollment([prepared.code_hash, prepared.credential_id, generated.spki, prepared.nonce]));
  requireSameConnection();
  const enrolled = await sendConsentCommand<{key_id: string; fingerprint: string}>('consent_key.enroll', {code, spki: generated.spki, signature});
  requireSameConnection();
  const key: LocalKey = {...enrolled, keyTag: generated.keyTag, state: 'pending_confirm'};
  // Metadata contains no secret. Keep the prior key until replacement confirms.
  await saveKeys([...(await localApprovalKeys()), key]);
  consentTelemetry('enrolled_pending', {key_id: key.key_id, fingerprint: key.fingerprint});
  return key;
}

// Explicit retry may reuse ONLY this exact tuple; it never enters reconnect replay.
const signedTuples = new Map<string, {key_id: string; signature: string}>();
export async function approveConsent(challenge: ConsentChallenge): Promise<unknown> {
  if (challenge.state !== 'pending' || challenge.expires_at * 1000 <= Date.now()) throw new Error('This approval has expired or already ended.');
  let tuple = signedTuples.get(challenge.challenge_id);
  if (!tuple) {
    const key = (await localApprovalKeys()).find((candidate) => challenge.audience_key_ids.includes(candidate.key_id));
    if (!key) throw new Error('Ask Bart to set up an Approval key for this phone.');
    let signature: string;
    try { signature = await nativeConsentSigner().signConsent(key.keyTag, challenge.challenge_bytes); }
    catch (error) {
      const status = keyFailure(error);
      if (status) await markKey(key.key_id, status);
      throw error;
    }
    tuple = {key_id: key.key_id, signature};
    signedTuples.set(challenge.challenge_id, tuple);
  }
  consentTelemetry('approve_sent', {challenge_id: challenge.challenge_id, key_id: tuple.key_id});
  let response: {receipt?: {consent_id?: string}; challenge?: {challenge_id?: string; state?: string; approved_by_key_id?: string}};
  try {
    response = await sendConsentCommand('consent.approve', {challenge_id: challenge.challenge_id, ...tuple});
  } catch (error) {
    const status = keyFailure(error);
    if (status) { await markKey(tuple.key_id, status); signedTuples.delete(challenge.challenge_id); }
    throw error;
  }
  if (response.receipt?.consent_id === challenge.challenge_id &&
      response.challenge?.challenge_id === challenge.challenge_id &&
      response.challenge.state === 'approved' && response.challenge.approved_by_key_id === tuple.key_id) {
    await markKey(tuple.key_id, 'active');
  }
  signedTuples.delete(challenge.challenge_id);
  consentTelemetry('approved', {challenge_id: challenge.challenge_id});
  return response;
}

export async function denyConsent(challenge: ConsentChallenge): Promise<unknown> {
  const result = await sendConsentCommand('consent.deny', {challenge_id: challenge.challenge_id});
  signedTuples.delete(challenge.challenge_id);
  consentTelemetry('denied', {challenge_id: challenge.challenge_id});
  return result;
}
