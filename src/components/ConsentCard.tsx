import { Tokens } from '@/constants/Colors';
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { openConsent, approveConsent, denyConsent, consentError, consentTelemetry, type ConsentChallenge, type ConsentIntent } from '../services/privilegedConsent';

export default function ConsentCard({intent, userOpened = false}: {intent: ConsentIntent; userOpened?: boolean}) {
  const [challenge, setChallenge] = useState<ConsentChallenge | null>(null);
  const [now,setNow] = useState(Date.now()); const [busy,setBusy] = useState(false);
  const [error,setError] = useState<string | null>(null); const [state,setState] = useState(intent.state);
  useEffect(()=>{setState(intent.state);},[intent.state]);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{consentTelemetry('card_rendered',{request_id:intent.request_id,state:intent.state});},[intent.request_id,intent.state]);
  const seconds=challenge ? Math.max(0,Math.ceil((challenge.expires_at*1000-now)/1000)) : 0;
  const open=async()=>{setBusy(true);setError(null);try{setChallenge(await openConsent(intent));setNow(Date.now());}
    catch(e){setError(consentError(e));}finally{setBusy(false);}};
  useEffect(()=>{if(userOpened&&intent.state==='pending') void open();},[userOpened,intent.request_id]);
  const act=async(approve:boolean)=>{if(!challenge)return;setBusy(true);setError(null);
    try{await(approve?approveConsent(challenge):denyConsent(challenge));setState(approve?'approved':'denied');}
    catch(e){setError(consentError(e));}finally{setBusy(false);}};
  return <View testID="consent-card" style={{padding:16,gap:8,backgroundColor:Tokens.palette.panel,borderColor:Tokens.palette.line,borderWidth:1,borderRadius:8}}>
    <Text style={{color:Tokens.palette.text}} accessibilityRole="header">Approval requested</Text>
    <Text style={{color:Tokens.palette.text}}>{intent.action}</Text>
    <Text style={{color:Tokens.palette.text}}>Target: {intent.target_stream_id}</Text>
    <Text style={{color:Tokens.palette.text}}>Generation: {intent.target_generation}</Text>
    <Text style={{color:Tokens.palette.text}}>Revision: {intent.expected_revision}</Text>
    <Text style={{color:Tokens.palette.text}}>Requester: {intent.requester.kind} {intent.requester.identity} {intent.requester.generation}</Text>
    <Text style={{color:Tokens.palette.text}}>{intent.display_text}</Text>
    {state!=='pending'?<Text style={{color:Tokens.palette.text}}>{state}</Text>:<>
      {!challenge || seconds===0?<><Text style={{color:Tokens.palette.text}}>{challenge?'Request timed out — open again to continue.':'Open this request to review and approve.'}</Text>
        <Button label="Open request" id="consent-open" disabled={busy} press={()=>void open()}/></>:
        <><Text style={{color:Tokens.palette.text}}>{seconds}s remaining</Text><Button label={busy?'Working…':'Approve with Face ID'} id="consent-approve" disabled={busy} press={()=>void act(true)}/>
        <Button label="Deny" id="consent-deny" disabled={busy} press={()=>void act(false)}/></>}
    </>}
    {error?<Text style={{color:Tokens.palette.text}} accessibilityRole="alert">{error}</Text>:null}
  </View>;
}
export function Button({label,id,disabled,press}:{label:string;id:string;disabled?:boolean;press:()=>void}) {
  return <Pressable testID={id} disabled={disabled} onPress={press} style={{padding:12,backgroundColor:Tokens.palette.line,borderRadius:6}}><Text style={{color:Tokens.palette.text}}>{label}</Text></Pressable>;
}
