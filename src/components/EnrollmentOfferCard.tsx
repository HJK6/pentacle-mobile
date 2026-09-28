import React, {useEffect,useState} from 'react';
import {Text,View} from 'react-native';
import {Tokens} from '@/constants/Colors';
import {Button} from './ConsentCard';
import {openOffer,acceptOffer,declineOffer,consentError,type EnrollmentOffer} from '../services/privilegedConsent';
export default function EnrollmentOfferCard({offer: initial,userOpened=false}:{offer:EnrollmentOffer;userOpened?:boolean}) {
  const [offer,setOffer]=useState(initial),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[now,setNow]=useState(Date.now());
  useEffect(()=>{if(initial.state!=='pending')setOffer(initial);},[initial.state]);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  const act=async(kind:'open'|'accept'|'decline')=>{setBusy(true);setError(null);try{setOffer(await(kind==='open'?openOffer(offer):kind==='accept'?acceptOffer(offer):declineOffer(offer)));setNow(Date.now());}
    catch(e){setError(consentError(e));}finally{setBusy(false);}};
  useEffect(()=>{if(userOpened&&initial.state==='pending')void act('open');},[userOpened,initial.offer_id]);
  const timedOut=offer.challenge_expires_at!==undefined&&offer.challenge_expires_at*1000<=now;
  return <View testID="consent-offer-card" style={{padding:16,gap:8,backgroundColor:Tokens.palette.panel,borderColor:Tokens.palette.line,borderWidth:1,borderRadius:8}}>
    <Text style={{color:Tokens.palette.text}} accessibilityRole="header">{offer.state==='accepted'?(offer.key_state==='active'?'Approval key ready':'Approval key no longer active'):offer.expected_prior_key_id?'Replace Approval key':'Set up Approval key?'}</Text>
    {offer.state==='pending'?<>
      <Text style={{color:Tokens.palette.text}}>Host: {offer.host_id} · Phone: {offer.label}</Text>
      <Text style={{color:Tokens.palette.text}}>Requested by: {offer.issuer.identity}</Text>
      <Text style={{color:Tokens.palette.text}}>Expires: {new Date(offer.expires_at*1000).toLocaleString()}</Text>
      <Text style={{color:Tokens.palette.text}}>Use Face ID to approve privileged requests from this host.</Text>
      {offer.expected_prior_key_id?<Text style={{color:Tokens.palette.text}}>Your current key stays usable until setup succeeds.</Text>:null}
      {!offer.challenge_id||timedOut?<>{timedOut?<Text style={{color:Tokens.palette.text}}>Request timed out — open again to continue.</Text>:null}<Button label="Open request" id="consent-offer-open" disabled={busy} press={()=>void act('open')}/></>:
        <Button label={busy?'Working…':'Set up with Face ID'} id="consent-offer-accept" disabled={busy} press={()=>void act('accept')}/>}
      <Button label="Not now" id="consent-offer-decline" disabled={busy} press={()=>void act('decline')}/>
    </>:offer.state==='accepted'&&offer.key_state==='active'?<Text style={{color:Tokens.palette.text}}>Each approval asks for Face ID.</Text>:<Text style={{color:Tokens.palette.text}}>{offer.state}</Text>}
    {error?<Text style={{color:Tokens.palette.text}} accessibilityRole="alert">{error}</Text>:null}
  </View>;
}
