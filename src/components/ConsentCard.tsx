import { Tokens } from '@/constants/Colors';
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { approveConsent, denyConsent, consentError, consentTelemetry, type ConsentChallenge } from '../services/privilegedConsent';

export default function ConsentCard({challenge}: {challenge: ConsentChallenge}) {
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    consentTelemetry('card_rendered', {challenge_id: challenge.challenge_id, state: challenge.state});
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [challenge.challenge_id, challenge.state]);
  const seconds = Math.max(0, Math.ceil((challenge.expires_at * 1000 - now) / 1000));
  const disabled = busy || challenge.state !== 'pending' || seconds === 0;
  const act = async (approve: boolean) => {
    setBusy(true); setError(null);
    try { await (approve ? approveConsent(challenge) : denyConsent(challenge)); }
    catch (e) { setError(consentError(e)); consentTelemetry('failed', {challenge_id: challenge.challenge_id, message: consentError(e)}); }
    finally { setBusy(false); }
  };
  return <View testID="consent-card" style={{padding: 16, gap: 8, backgroundColor: Tokens.palette.panel, borderColor: Tokens.palette.line, borderWidth: 1, borderRadius: 8}}>
    <Text style={{color: Tokens.palette.text}} accessibilityRole="header">Approve privileged action</Text>
    <Text style={{color: Tokens.palette.text}}>{challenge.action}</Text>
    <Text style={{color: Tokens.palette.text}}>Target: {challenge.target_stream_id}</Text>
    <Text style={{color: Tokens.palette.text}}>Generation: {challenge.target_generation}</Text>
    <Text style={{color: Tokens.palette.text}}>Revision: {challenge.expected_revision}</Text>
    <Text style={{color: Tokens.palette.text}}>Requester: {challenge.requester.kind} {challenge.requester.identity} {challenge.requester.generation}</Text>
    <Text style={{color: Tokens.palette.text}}>{challenge.display_text}</Text>
    <Text style={{color: Tokens.palette.text}}>{challenge.state === 'pending' ? `${seconds}s remaining` : challenge.state}</Text>
    {error ? <Text style={{color: Tokens.palette.text}} accessibilityRole="alert">{error}</Text> : null}
    <Pressable style={{padding: 10, backgroundColor: Tokens.palette.line, borderRadius: 6}} testID="consent-approve" disabled={disabled} onPress={() => void act(true)}><Text style={{color: Tokens.palette.text}}>{busy ? 'Working…' : 'Approve with Face ID'}</Text></Pressable>
    <Pressable style={{padding: 10, backgroundColor: Tokens.palette.line, borderRadius: 6}} testID="consent-deny" disabled={disabled} onPress={() => void act(false)}><Text style={{color: Tokens.palette.text}}>Deny</Text></Pressable>
  </View>;
}
