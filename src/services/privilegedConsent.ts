import * as SecureStore from 'expo-secure-store';
import { fromByteArray, toByteArray } from 'base64-js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { nativeConsentSigner } from '../../modules/pentacle-consent';
import { consentConnection, sendConsentCommand, type ConsentConnection } from './pentacleStream';

export type ConsentIntent = {
  request_id: string; host_id: string; action: 'lifecycle.designate' | 'lifecycle.revoke';
  target_stream_id: string; target_generation: string; expected_revision: number;
  requester: { kind: string; identity: string; generation: string };
  audience_key_ids: string[]; display_text: string; expires_at: number; state: string;
};
export type ConsentChallenge = Omit<ConsentIntent, 'request_id' | 'host_id'> & {
  connection_scope: string; challenge_id: string; audience_hash: string; challenge_bytes: string;
};
export type EnrollmentOffer = {
  offer_id: string; host_id: string; credential_id: string; label: string;
  issuer: {kind: string; identity: string}; expected_prior_key_id?: string | null;
  expires_at: number; state: string; accepted_key_id?: string; key_state?: string;
  challenge_id?: string; nonce?: string; challenge_expires_at?: number;
};
export type LocalKey = {key_id: string; keyTag: string; fingerprint?: string; scope?: string;
  state?: 'pending_confirm' | 'active' | 'revoked' | 'invalidated'};
const METADATA = 'pentacle-consent-key-metadata-v1';
function hex(bytes: Uint8Array) { return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''); }
function recordKey(scope: string, kind: string, id: string) {return 'pentacle-consent-' + hex(sha256(utf8ToBytes(JSON.stringify([scope,kind,id]))));}
function connection(expectedHost?: string): ConsentConnection {
  const current = consentConnection();
  if (!current || (expectedHost && current.host_id !== expectedHost)) throw new Error('Reconnect to this host to continue.');
  return current;
}
function same(before: ConsentConnection) {
  const after = connection();
  if (after.scope !== before.scope || after.generation !== before.generation) throw new Error('Host connection changed. Open this request again.');
}
export function consentTelemetry(event: string, data: Record<string, unknown> = {}) {
  const line = `[TELEMETRY] ${JSON.stringify({subsystem:'consent', message:`consent.${event}`, bug_ref:'mobile_faceid_privileged_consent_2026_09',data})}`;
  const hook = (globalThis as unknown as {nativeLoggingHook?: (line: string, level: number) => void}).nativeLoggingHook;
  if (typeof hook === 'function') hook(line,2); else console.log(line);
}
export function consentError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (['key_invalidated','consent_key_invalid','consent_key_revoked'].some((code) => message.includes(code))) return 'Ask this host to send a new setup request.';
  if (message.includes('biometry_lockout')) return 'Face ID is locked. Unlock Face ID, then retry.';
  if (message.includes('cancelled')) return 'Face ID approval canceled.';
  if (message.includes('biometry_unavailable') || message.includes('face_id_required')) return 'Face ID is required for this approval.';
  if (message.includes('consent_expired')) return 'Request timed out — open again to continue.';
  return message;
}
export function framedOffer(fields: string[]): string {
  const parts = ['pentacle-consent-enroll-offer-v1', ...fields].map(utf8ToBytes);
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + 4 + part.length, 0));
  const view = new DataView(bytes.buffer); let offset = 0;
  parts.forEach((part) => {view.setUint32(offset,part.length,false);bytes.set(part,offset+4);offset+=4+part.length;});
  return fromByteArray(bytes);
}
export async function localApprovalKeys(): Promise<LocalKey[]> {
  const stored = await SecureStore.getItemAsync(METADATA);
  return stored ? JSON.parse(stored) as LocalKey[] : [];
}
async function saveKeys(keys: LocalKey[]) {await SecureStore.setItemAsync(METADATA,JSON.stringify(keys));}
async function markKey(id: string, state: LocalKey['state'], scope?: string) {
  await saveKeys((await localApprovalKeys()).map((key) => key.key_id === id ? {...key,state,...(scope ? {scope} : {})} : key));
}
function keyFailure(error: unknown): LocalKey['state'] | undefined {
  const code = error instanceof Error ? error.message : '';
  if (code === 'consent_key_revoked') return 'revoked';
  if (['consent_key_invalid','key_invalidated','biometry_unavailable','face_id_required'].includes(code)) return 'invalidated';
}
export async function openOffer(offer: EnrollmentOffer): Promise<EnrollmentOffer> {
  const before = connection(offer.host_id);
  if (before.credential_id !== offer.credential_id) throw new Error('This setup request belongs to another phone.');
  const storage=recordKey(before.scope,'offer',offer.offer_id);
  const saved=await SecureStore.getItemAsync(storage); same(before);
  const record=saved ? JSON.parse(saved) as OfferRecord : undefined;
  if(record?.tuple) {
    const status=await sendConsentCommand<OfferResponse>('consent_key.status',{offer_id:offer.offer_id});same(before);
    if(status.offer.state==='accepted') return bindOffer(record,status,before);
    if(status.offer.state!=='pending') return status.offer;
  }
  const response = await sendConsentCommand<{offer: EnrollmentOffer}>('consent_key.open',{offer_id:offer.offer_id});
  same(before);
  if(record && record.challenge_id!==response.offer.challenge_id) {
    const fresh={...record,challenge_id:response.offer.challenge_id!,tuple:undefined};
    await SecureStore.setItemAsync(storage,JSON.stringify(fresh));same(before);
  }
  return response.offer;
}
type OfferRecord = {scope: string; offer_id: string; keyTag: string; spki: string; challenge_id: string;
  tuple?: {offer_id: string; challenge_id: string; spki: string; signature: string}};
type OfferResponse = {offer: EnrollmentOffer; receipt?: {offer_id: string; host_id: string; credential_id: string; key_id: string; spki_hash: string}};
async function bindOffer(record: OfferRecord, result: OfferResponse, before: ConsentConnection) {
  const receipt = result.receipt;
  if (!receipt || receipt.offer_id !== record.offer_id || receipt.host_id !== before.host_id || receipt.credential_id !== before.credential_id ||
      receipt.spki_hash !== hex(sha256(toByteArray(record.spki))) || result.offer.accepted_key_id !== receipt.key_id) throw new Error('Setup receipt does not match this phone key.');
  const prior = await localApprovalKeys(); same(before);
  const state: LocalKey['state']=result.offer.key_state === 'active' ? 'active' : 'revoked';
  const existing=prior.find(key=>key.key_id===receipt.key_id);
  await saveKeys(existing?prior.map(key=>key.key_id===receipt.key_id?{...key,state,scope:before.scope}:key):[...prior,{key_id:receipt.key_id,keyTag:record.keyTag,scope:before.scope,state}]);
  same(before);return result.offer;
}
export async function acceptOffer(offer: EnrollmentOffer): Promise<EnrollmentOffer> {
  const before = connection(offer.host_id);
  if (before.credential_id !== offer.credential_id) throw new Error('This setup request belongs to another phone.');
  const storage = recordKey(before.scope,'offer',offer.offer_id);
  const saved = await SecureStore.getItemAsync(storage); same(before);
  let record = saved ? JSON.parse(saved) as OfferRecord : undefined;
  if (record?.tuple) {
    // Resolve an ambiguous response before any different key, challenge or signature.
    const status = await sendConsentCommand<OfferResponse>('consent_key.status',{offer_id:offer.offer_id}); same(before);
    if (status.offer.state === 'accepted') return bindOffer(record,status,before);
    if (record.challenge_id !== offer.challenge_id) throw new Error('Open the original request to reconcile its submitted response.');
  }
  if (offer.state !== 'pending' || !offer.challenge_id || !offer.nonce || !offer.challenge_expires_at || offer.challenge_expires_at*1000<=Date.now()) throw new Error('Request timed out — open again to continue.');
  if (!record || record.challenge_id !== offer.challenge_id) {
    const generated = await nativeConsentSigner().createKey(); same(before);
    record = {...generated,scope:before.scope,offer_id:offer.offer_id,challenge_id:offer.challenge_id};
    await SecureStore.setItemAsync(storage,JSON.stringify(record)); same(before);
  }
  if (!record.tuple) {
    const signature = await nativeConsentSigner().signConsent(record.keyTag,framedOffer([offer.offer_id,offer.host_id,offer.credential_id,
      offer.issuer.kind,offer.issuer.identity,offer.challenge_id,offer.nonce,String(offer.challenge_expires_at),offer.expected_prior_key_id || '',record.spki]));
    same(before);
    record.tuple = {offer_id:offer.offer_id,challenge_id:offer.challenge_id,spki:record.spki,signature};
    await SecureStore.setItemAsync(storage,JSON.stringify(record)); same(before);
  }
  const response = await sendConsentCommand<OfferResponse>('consent_key.accept',record.tuple); same(before);
  const result = await bindOffer(record,response,before);
  consentTelemetry('offer_accepted',{offer_id:offer.offer_id,state:result.key_state}); return result;
}
export async function declineOffer(offer: EnrollmentOffer) {
  const before=connection(offer.host_id);
  const result=await sendConsentCommand<{offer: EnrollmentOffer}>('consent_key.decline',{offer_id:offer.offer_id}); same(before); return result.offer;
}
export async function openConsent(intent: ConsentIntent): Promise<ConsentChallenge> {
  const before=connection(intent.host_id);
  const key=(await localApprovalKeys()).find((candidate)=>intent.audience_key_ids.includes(candidate.key_id)&&(!candidate.scope||candidate.scope===before.scope));
  same(before);
  if (!key) throw new Error('Ask this host to send a new setup request.');
  const result=await sendConsentCommand<{challenge: ConsentChallenge}>('consent.open',{intent_id:intent.request_id,key_id:key.key_id});same(before);
  return {...result.challenge,connection_scope:before.scope};
}
export async function approveConsent(challenge: ConsentChallenge): Promise<unknown> {
  const before=connection();
  if(challenge.connection_scope!==before.scope)throw new Error('Host connection changed. Open this request again.');
  const storage=recordKey(before.scope,'approval',challenge.challenge_id);
  const stored=await SecureStore.getItemAsync(storage); same(before);
  let tuple=stored ? JSON.parse(stored) as {key_id: string; signature: string} : null;
  if (!tuple) {
    if (challenge.state!=='pending'||challenge.expires_at*1000<=Date.now()) throw new Error('This approval has expired or already ended.');
    const key=(await localApprovalKeys()).find((candidate)=>challenge.audience_key_ids.includes(candidate.key_id)&&(!candidate.scope||candidate.scope===before.scope));
    same(before);
    if (!key) throw new Error('Ask this host to send a new setup request.');
    let signature: string;
    try {signature=await nativeConsentSigner().signConsent(key.keyTag,challenge.challenge_bytes);}
    catch(error){const status=keyFailure(error);if(status)await markKey(key.key_id,status);throw error;}
    same(before); tuple={key_id:key.key_id,signature};
    await SecureStore.setItemAsync(storage,JSON.stringify(tuple)); same(before);
  }
  let response: {receipt?: {consent_id?: string};challenge?: {challenge_id?: string;state?: string;approved_by_key_id?: string}};
  try {response=await sendConsentCommand('consent.approve',{challenge_id:challenge.challenge_id,...tuple});}
  catch(error){const status=keyFailure(error);if(status)await markKey(tuple.key_id,status);throw error;}
  same(before);
  if(response.receipt?.consent_id!==challenge.challenge_id||response.challenge?.challenge_id!==challenge.challenge_id||response.challenge.state!=='approved'||response.challenge.approved_by_key_id!==tuple.key_id) throw new Error('Approval receipt does not match this request.');
  await markKey(tuple.key_id,'active',before.scope);same(before);
  // Retain the exact signed tuple for explicit receipt-only retries after process loss.
  consentTelemetry('approved',{challenge_id:challenge.challenge_id}); return response;
}
export async function denyConsent(challenge: ConsentChallenge): Promise<unknown> {
  const before=connection();
  if(challenge.connection_scope!==before.scope)throw new Error('Host connection changed. Open this request again.');
  const key=(await localApprovalKeys()).find((candidate)=>challenge.audience_key_ids.includes(candidate.key_id)&&(!candidate.scope||candidate.scope===before.scope));
  same(before);
  const result=await sendConsentCommand('consent.deny',{challenge_id:challenge.challenge_id,key_id:key?.key_id});same(before);return result;
}
