import {
  createOperatorAuthV2Hello,
  parseOperatorAuthV2Envelope,
} from '../../src/services/operatorAuthV2';

const CREDENTIAL_ID = '123e4567-e89b-12d3-a456-426614174000';
const NONCE = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8';
const ENVELOPE = 'pentacle-auth-v2:eyJjbGllbnRfa2luZCI6InBlbnRhY2xlLW1vYmlsZSIsImNyZWRlbnRpYWxfaWQiOiIxMjNlNDU2Ny1lODliLTEyZDMtYTQ1Ni00MjY2MTQxNzQwMDAiLCJwcm9vZl9rZXkiOiJBQUVDQXdRRkJnY0lDUW9MREEwT0R4QVJFaE1VRlJZWEdCa2FHeHdkSGg4IiwidmVyc2lvbiI6Mn0';

function encodedEnvelope(payload: Record<string, unknown>) {
  return `pentacle-auth-v2:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

const BASE_PAYLOAD = {
  client_kind: 'pentacle-mobile',
  credential_id: CREDENTIAL_ID,
  proof_key: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  version: 2,
};

test('matches the server HMAC-SHA256 transcript vector', () => {
  const credential = parseOperatorAuthV2Envelope(ENVELOPE);
  expect(createOperatorAuthV2Hello(credential, {
    type: 'welcome',
    auth: {
      operator: {
        protocol_version: 2,
        scheme: 'hmac-sha256-v2',
        nonce: NONCE,
        expires_at: 2_000,
      },
    },
  }, 1_000)).toEqual({
    scheme: 'hmac-sha256-v2',
    credential_id: CREDENTIAL_ID,
    proof: 'QWJj1o4FTDWE1plG9nBVmVCzVzmSci7Q1fZkWUoR97w',
  });
});

test.each([
  'pentacle-auth-v2:not-base64!',
  `${ENVELOPE}=`,
  ENVELOPE.replace('eyJ', 'EyJ'),
  encodedEnvelope({ ...BASE_PAYLOAD, version: 1 }),
  encodedEnvelope({ ...BASE_PAYLOAD, client_kind: 'pentacle' }),
  encodedEnvelope({ ...BASE_PAYLOAD, credential_id: CREDENTIAL_ID.toUpperCase() }),
  encodedEnvelope({ ...BASE_PAYLOAD, proof_key: 'c2hvcnQ' }),
  encodedEnvelope({ ...BASE_PAYLOAD, extra: true }),
  encodedEnvelope({ version: 2, proof_key: BASE_PAYLOAD.proof_key, credential_id: CREDENTIAL_ID, client_kind: 'pentacle-mobile' }),
])('rejects malformed or non-canonical envelopes locally', (value) => {
  expect(() => parseOperatorAuthV2Envelope(value)).toThrow('operator_auth_v2_invalid');
});

test.each([
  {},
  { auth: { operator: { protocol_version: 1, scheme: 'hmac-sha256-v2', nonce: NONCE, expires_at: 2_000 } } },
  { auth: { operator: { protocol_version: 2, scheme: 'shared-bearer-v1', nonce: NONCE, expires_at: 2_000 } } },
  { auth: { operator: { protocol_version: 2, scheme: 'hmac-sha256-v2', nonce: 'forged', expires_at: 2_000 } } },
  { auth: { operator: { protocol_version: 2, scheme: 'hmac-sha256-v2', nonce: NONCE, expires_at: 999 } } },
])('rejects missing, downgraded, forged, or expired welcome metadata', (welcome) => {
  const credential = parseOperatorAuthV2Envelope(ENVELOPE);
  expect(() => createOperatorAuthV2Hello(credential, welcome, 1_000)).toThrow('operator_auth_v2_required');
});
