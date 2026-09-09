import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

export const OPERATOR_AUTH_V2_PREFIX = 'pentacle-auth-v2:';
export const OPERATOR_AUTH_V2_SCHEME = 'hmac-sha256-v2';
export const OPERATOR_AUTH_V2_CLIENT_KIND = 'pentacle-mobile';
export const OPERATOR_AUTH_V2_WELCOME_TIMEOUT_MS = 5_000;

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type OperatorAuthV2Credential = {
  version: 2;
  credentialId: string;
  clientKind: typeof OPERATOR_AUTH_V2_CLIENT_KIND;
  proofKey: Uint8Array;
};

type OperatorWelcome = {
  protocol_version: number;
  scheme: string;
  nonce: string;
  expires_at: number;
};

function encodeBase64Url(bytes: Uint8Array): string {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const first = bytes[offset];
    const second = bytes[offset + 1];
    const third = bytes[offset + 2];
    result += BASE64URL_ALPHABET[first >> 2];
    result += BASE64URL_ALPHABET[((first & 3) << 4) | ((second ?? 0) >> 4)];
    if (second !== undefined) result += BASE64URL_ALPHABET[((second & 15) << 2) | ((third ?? 0) >> 6)];
    if (third !== undefined) result += BASE64URL_ALPHABET[third & 63];
  }
  return result;
}

function decodeBase64Url(value: unknown, expectedBytes?: number): Uint8Array {
  if (typeof value !== 'string' || !value || value.includes('=') || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('operator_auth_v2_invalid');
  }
  if (value.length % 4 === 1) throw new Error('operator_auth_v2_invalid');
  const output: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const character of value) {
    const digit = BASE64URL_ALPHABET.indexOf(character);
    if (digit < 0) throw new Error('operator_auth_v2_invalid');
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output.push((accumulator >> bits) & 255);
    }
  }
  const decoded = Uint8Array.from(output);
  if (encodeBase64Url(decoded) !== value || (expectedBytes !== undefined && decoded.length !== expectedBytes)) {
    throw new Error('operator_auth_v2_invalid');
  }
  return decoded;
}

function canonicalEnvelope(credentialId: string, proofKey: Uint8Array): string {
  const payload = JSON.stringify({
    client_kind: OPERATOR_AUTH_V2_CLIENT_KIND,
    credential_id: credentialId,
    proof_key: encodeBase64Url(proofKey),
    version: 2,
  });
  return OPERATOR_AUTH_V2_PREFIX + encodeBase64Url(utf8ToBytes(payload));
}

export function parseOperatorAuthV2Envelope(value: string): OperatorAuthV2Credential {
  if (!value.startsWith(OPERATOR_AUTH_V2_PREFIX)) throw new Error('operator_auth_v2_invalid');
  let payload: unknown;
  try {
    const raw = decodeBase64Url(value.slice(OPERATOR_AUTH_V2_PREFIX.length));
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    throw new Error('operator_auth_v2_invalid');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('operator_auth_v2_invalid');
  const record = payload as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'client_kind,credential_id,proof_key,version'
    || record.version !== 2
    || record.client_kind !== OPERATOR_AUTH_V2_CLIENT_KIND
    || typeof record.credential_id !== 'string'
    || !UUID_PATTERN.test(record.credential_id)
  ) {
    throw new Error('operator_auth_v2_invalid');
  }
  const proofKey = decodeBase64Url(record.proof_key, 32);
  if (canonicalEnvelope(record.credential_id, proofKey) !== value) throw new Error('operator_auth_v2_invalid');
  return {
    version: 2,
    credentialId: record.credential_id,
    clientKind: OPERATOR_AUTH_V2_CLIENT_KIND,
    proofKey,
  };
}

function parseWelcome(value: unknown, nowSeconds: number): OperatorWelcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('operator_auth_v2_required');
  const message = value as Record<string, unknown>;
  const auth = message.auth;
  const operator = auth && typeof auth === 'object' && !Array.isArray(auth)
    ? (auth as Record<string, unknown>).operator
    : null;
  if (!operator || typeof operator !== 'object' || Array.isArray(operator)) throw new Error('operator_auth_v2_required');
  const record = operator as Record<string, unknown>;
  if (
    record.protocol_version !== 2
    || record.scheme !== OPERATOR_AUTH_V2_SCHEME
    || typeof record.nonce !== 'string'
    || typeof record.expires_at !== 'number'
    || !Number.isFinite(record.expires_at)
    || record.expires_at <= nowSeconds
  ) {
    throw new Error('operator_auth_v2_required');
  }
  try {
    decodeBase64Url(record.nonce, 32);
  } catch {
    throw new Error('operator_auth_v2_required');
  }
  return record as OperatorWelcome;
}

export function createOperatorAuthV2Hello(
  credential: OperatorAuthV2Credential,
  welcome: unknown,
  nowSeconds = Date.now() / 1000,
) {
  const operator = parseWelcome(welcome, nowSeconds);
  const transcript = utf8ToBytes(
    `pentacle-operator-v2\0chat-streamd\0${operator.nonce}\0${credential.credentialId}\0${credential.clientKind}`,
  );
  return {
    scheme: OPERATOR_AUTH_V2_SCHEME,
    credential_id: credential.credentialId,
    proof: encodeBase64Url(hmac(sha256, credential.proofKey, transcript)),
  };
}
