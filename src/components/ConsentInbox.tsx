import React,{useState} from 'react';
import {Pressable,Text,View} from 'react-native';
import {useGlobalSearchParams,usePathname} from 'expo-router';
import {Tokens} from '@/constants/Colors';
import {usePentacleStreamSelector,consentConnection} from '../services/pentacleStream';
import {navigateConsent} from '../services/consentNavigation';
export default function ConsentInbox() {
  const notifications=usePentacleStreamSelector(state=>state.notifications);
  const connected=usePentacleStreamSelector(state=>state.connected);
  const pathname=usePathname();const params=useGlobalSearchParams();const [dismissed,setDismissed]=useState<string[]>([]);
  const current=consentConnection();
  if(!connected||!current)return null;
  const record=notifications.find((notification:any)=>{
    const request=notification.consent_offer||notification.consent;
    const alreadyOpen=pathname==='/approval'&&params.host_id===request?.host_id&&
      params.request_id===(request?.offer_id||request?.request_id)&&params.kind===(notification.consent_offer?'enrollment':'approval');
    return request?.state==='pending'&&request.host_id===current.host_id&&!alreadyOpen&&!dismissed.includes(notification.notification_id);
  }) as any;
  if(!record)return null;
  const request=record.consent_offer||record.consent;
  return <View testID="consent-inbox" style={{position:'absolute',left:16,right:16,top:70,padding:16,gap:12,backgroundColor:Tokens.palette.panel,borderColor:Tokens.palette.line,borderWidth:2,borderRadius:8}}>
    <Text style={{color:Tokens.palette.text}}>{record.consent_offer?'Set up Approval key?':'Approval requested'}</Text>
    <Pressable testID="consent-inbox-open" onPress={()=>navigateConsent({kind:record.consent_offer?'enrollment':'approval',host_id:request.host_id,request_id:request.offer_id||request.request_id})}><Text style={{color:Tokens.palette.text}}>Open request</Text></Pressable>
    <Pressable onPress={()=>setDismissed([...dismissed,record.notification_id])}><Text style={{color:Tokens.palette.text}}>Later</Text></Pressable>
  </View>;
}
