import { Tokens } from '@/constants/Colors';
import React, { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useConsentEnrollmentReady } from '../services/pentacleStream';
import { consentError, enrollApprovalKey, localApprovalKeys, subscribeApprovalKeys, type LocalKey } from '../services/privilegedConsent';

export default function ApprovalKeySettings() {
  const ready = useConsentEnrollmentReady();
  const [code, setCode] = useState('');
  const [keys, setKeys] = useState<LocalKey[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    const refresh = () => { void localApprovalKeys().then((saved) => { if (mounted) setKeys(saved); }).catch(() => { if (mounted) setError('Approval key status could not be read.'); }); };
    const stop = subscribeApprovalKeys(refresh);
    refresh();
    return () => { mounted = false; stop(); };
  }, []);
  // A code is short-lived and belongs to the connection on which it was entered.
  useEffect(() => { if (!ready) setCode(''); }, [ready]);
  const enroll = async () => {
    if (!ready || busy) return;
    setBusy(true); setError(null);
    try { await enrollApprovalKey(code.trim().toUpperCase()); setCode(''); }
    catch (e) { setError(consentError(e)); }
    finally { setBusy(false); }
  };
  const text = { color: Tokens.palette.text };
  return <View testID="approval-key-settings" style={{padding: 16, gap: 8, backgroundColor: Tokens.palette.panel, borderColor: Tokens.palette.line, borderWidth: 1, borderRadius: 8}}>
    <Text style={text} accessibilityRole="header">Approval key</Text>
    <Text style={text}>Face ID unlocks this app. An Approval key lets this phone approve privileged actions requested by Bart. Bart will provide a host code when this is ready.</Text>
    <Text style={text}>Each new approval asks for Face ID. Ordinary sign-in grants no lifecycle authority.</Text>
    {ready ? <>
      <TextInput style={{...text, borderWidth: 1, borderColor: Tokens.palette.line, padding: 10}} placeholderTextColor={Tokens.palette.muted} testID="approval-enrollment-code" accessibilityLabel="Enrollment code" value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} maxLength={8} placeholder="8-character host code" secureTextEntry />
      <Pressable style={{padding: 10, backgroundColor: Tokens.palette.line, borderRadius: 6}} testID="approval-enroll" disabled={busy || code.trim().length !== 8} onPress={() => void enroll()}><Text style={text}>{busy ? 'Enrolling…' : keys.length ? 'Re-enroll with Face ID' : 'Enroll with Face ID'}</Text></Pressable>
    </> : <Text style={text}>Not active yet</Text>}
    {keys.map((key) => <View key={key.keyTag} style={{gap: 8}}>
      <Text style={text} selectable>{key.fingerprint.match(/.{1,8}/g)?.join(' ')}</Text>
      <Text style={text}>{key.state === 'active' ? 'Active after a verified approval' : key.state === 'revoked' ? 'Approval key revoked' : key.state === 'invalidated' ? 'Approval key unavailable' : 'Waiting for host confirmation'}</Text>
      {(!key.state || key.state === 'pending_confirm') ? <Text style={text}>Bart must confirm the fingerprint read from this screen before this key can approve. It shows as active after its first approval. If Bart did not confirm within 10 minutes, ask for a new host code.</Text> : null}
    </View>)}
    {error ? <Text style={text} accessibilityRole="alert">{error}</Text> : null}
  </View>;
}
