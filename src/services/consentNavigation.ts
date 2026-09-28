import {router} from 'expo-router';
import {consentConnection} from './pentacleStream';
export type ConsentHint = {kind:'enrollment'|'approval';host_id:string;request_id:string};
const gestures=new Map<string,{hint:ConsentHint;scope:string;time:number}>();
export function consentHint(data:Record<string,unknown>):ConsentHint|null {
  if((data.kind!=='enrollment'&&data.kind!=='approval')||typeof data.host_id!=='string'||typeof data.request_id!=='string'||!data.request_id||data.request_id.length>200)return null;
  return{kind:data.kind,host_id:data.host_id,request_id:data.request_id};
}
export function navigateConsent(hint:ConsentHint) {
  const current=consentConnection();
  if(!current||current.host_id!==hint.host_id)return false;
  const token=String(Date.now())+'-'+Math.random().toString(36).slice(2);
  gestures.set(token,{hint,scope:current.scope,time:Date.now()});
  router.push({pathname:'/approval',params:{...hint,gesture:token}} as any);return true;
}
export function consumeConsentGesture(token:string,hint:ConsentHint) {
  const gesture=gestures.get(token);gestures.delete(token);
  return Boolean(gesture&&Date.now()-gesture.time<60000&&gesture.scope===consentConnection()?.scope&&JSON.stringify(gesture.hint)===JSON.stringify(hint));
}
