import React,{useEffect,useState} from 'react';
import {ScrollView,Text,Pressable} from 'react-native';
import {router,useLocalSearchParams} from 'expo-router';
import {Tokens} from '@/constants/Colors';
import ConsentCard from '../src/components/ConsentCard';
import EnrollmentOfferCard from '../src/components/EnrollmentOfferCard';
import {consentConnection,sendConsentCommand,usePentacleStreamSelector} from '../src/services/pentacleStream';
import {consentHint,consumeConsentGesture} from '../src/services/consentNavigation';
import {consentError,type EnrollmentOffer,type ConsentIntent} from '../src/services/privilegedConsent';
export default function ApprovalRequest() {
  const params=useLocalSearchParams();const [record,setRecord]=useState<EnrollmentOffer|ConsentIntent|null>(null),[error,setError]=useState(''),[userOpened,setUserOpened]=useState(false);
  const scope=usePentacleStreamSelector(()=>consentConnection()?.scope||'',Object.is);
  useEffect(()=>{
    setRecord(null);setError('');setUserOpened(false);
    let live=true;const hint=consentHint(params as Record<string,unknown>);const before=consentConnection();
    if(!hint||!before||before.host_id!==hint.host_id){setError('Reconnect to the request’s host to continue.');return;}
    const fromTap=consumeConsentGesture(String(params.gesture||''),hint);
    // Reading detail is presentation only. Only a consumed actual tap starts signing time.
    void sendConsentCommand<{offer?:EnrollmentOffer;intent?:ConsentIntent}>(hint.kind==='enrollment'?'consent_key.status':'consent.status',
      hint.kind==='enrollment'?{offer_id:hint.request_id}:{intent_id:hint.request_id}).then(result=>{
        if(!live||consentConnection()?.scope!==before.scope)return;
        setRecord(result.offer||result.intent||null);setUserOpened(fromTap);
      }).catch(e=>{if(live)setError(consentError(e));});
    return()=>{live=false;};
  },[params.kind,params.host_id,params.request_id,params.gesture,scope]);
  return <ScrollView style={{flex:1,backgroundColor:Tokens.palette.panel}} contentContainerStyle={{padding:20,paddingTop:70,gap:16}}>
    <Pressable onPress={()=>router.back()}><Text style={{color:Tokens.palette.text}}>Back</Text></Pressable>
    {error?<Text accessibilityRole="alert" style={{color:Tokens.palette.text}}>{error}</Text>:null}
    {record&&'offer_id'in record?<EnrollmentOfferCard offer={record} userOpened={userOpened}/>:record&&'request_id'in record?<ConsentCard intent={record} userOpened={userOpened}/>:null}
  </ScrollView>;
}
