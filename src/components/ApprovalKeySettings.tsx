import { Tokens } from '@/constants/Colors';
import React, { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { consentError, enrollApprovalKey } from '../services/privilegedConsent';

export default function ApprovalKeySettings() {
  const [code, setCode] = useState('');
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enroll = async () => {
    setBusy(true); setError(null);
    try { const key = await enrollApprovalKey(code.trim().toUpperCase()); setFingerprint(key.fingerprint); setCode(''); }
    catch (e) { setError(consentError(e)); }
    finally { setBusy(false); }
  };
  return <View testID="approval-key-settings" style={{padding: 16, gap: 8, backgroundColor: Tokens.palette.panel, borderColor: Tokens.palette.line, borderWidth: 1, borderRadius: 8}}>
    <Text style={{color: Tokens.palette.text}} accessibilityRole="header">Approval key</Text>
    <Text style={{color: Tokens.palette.text}}>Enrol this phone to approve lifecycle actions with Face ID.</Text>
    <TextInput style={{color: Tokens.palette.text, borderWidth: 1, borderColor: Tokens.palette.line, padding: 10}} placeholderTextColor={Tokens.palette.muted} testID="approval-enrollment-code" accessibilityLabel="Enrolment code" value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} maxLength={8} placeholder="8-character host code" />
    <Pressable style={{padding: 10, backgroundColor: Tokens.palette.line, borderRadius: 6}} testID="approval-enroll" disabled={busy || code.trim().length !== 8} onPress={() => void enroll()}><Text style={{color: Tokens.palette.text}}>{busy ? 'Enrolling…' : 'Enrol with Face ID'}</Text></Pressable>
    {fingerprint ? <><Text style={{color: Tokens.palette.text}} selectable>{fingerprint.match(/.{1,8}/g)?.join(' ')}</Text><Text style={{color: Tokens.palette.text}}>Read this fingerprint and confirm it from the same host. Until confirmed, this key cannot approve.</Text></> : null}
    {error ? <Text style={{color: Tokens.palette.text}} accessibilityRole="alert">{error}</Text> : null}
  </View>;
}
