import * as SecureStore from 'expo-secure-store';
import { fromByteArray } from 'base64-js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { nativeConsentSigner } from '../../modules/pentacle-consent';
import { sendConsentCommand } from './pentacleStream';

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
type LocalKey = { key_id: string; keyTag: string; fingerprint: string };
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
  if (message.includes('key_invalidated')) return 'Approval key needs re-enrolment.';
  if (message.includes('biometry_lockout')) return 'Face ID is locked. Unlock Face ID, then retry.';
  if (message.includes('cancelled')) return 'Face ID approval cancelled.';
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

async function localKeys(): Promise<LocalKey[]> {
  const stored = await SecureStore.getItemAsync(METADATA);
  return stored ? JSON.parse(stored) as LocalKey[] : [];
}

export async function enrollApprovalKey(code: string): Promise<LocalKey> {
  const prepared = await sendConsentCommand<{code_hash: string; credential_id: string; nonce: string}>('consent_key.prepare', { code });
  const signer = nativeConsentSigner();
  const generated = await signer.createKey();
  const signature = await signer.signConsent(generated.keyTag,
    framedEnrollment([prepared.code_hash, prepared.credential_id, generated.spki, prepared.nonce]));
  const enrolled = await sendConsentCommand<{key_id: string; fingerprint: string}>('consent_key.enroll', {code, spki: generated.spki, signature});
  const key = {...enrolled, keyTag: generated.keyTag};
  // Metadata contains no secret. Keep the prior key until replacement confirms.
  await SecureStore.setItemAsync(METADATA, JSON.stringify([...(await localKeys()), key]));
  consentTelemetry('enrolled_pending', {key_id: key.key_id, fingerprint: key.fingerprint});
  return key;
}

// Explicit retry may reuse ONLY this exact tuple; it never enters reconnect replay.
const signedTuples = new Map<string, {key_id: string; signature: string}>();
export async function approveConsent(challenge: ConsentChallenge): Promise<unknown> {
  if (challenge.state !== 'pending' || challenge.expires_at * 1000 <= Date.now()) throw new Error('This approval has expired or already ended.');
  let tuple = signedTuples.get(challenge.challenge_id);
  if (!tuple) {
    const key = (await localKeys()).find((candidate) => challenge.audience_key_ids.includes(candidate.key_id));
    if (!key) throw new Error('Enrol an approval key for this phone in Settings.');
    const signature = await nativeConsentSigner().signConsent(key.keyTag, challenge.challenge_bytes);
    tuple = {key_id: key.key_id, signature};
    signedTuples.set(challenge.challenge_id, tuple);
  }
  consentTelemetry('approve_sent', {challenge_id: challenge.challenge_id, key_id: tuple.key_id});
  const response = await sendConsentCommand('consent.approve', {challenge_id: challenge.challenge_id, ...tuple});
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
