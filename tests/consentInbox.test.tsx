import React from 'react';
import {act,fireEvent,render} from '@testing-library/react-native';
import {router} from 'expo-router';
import ConsentInbox from '../src/components/ConsentInbox';
import {consumeConsentGesture,navigateConsent} from '../src/services/consentNavigation';
let mockScope='host|phone';
let mockConnected=true;
let mockPath='/chats';
let mockParams:Record<string,string>={};
let mockRecords:any[]=[];
jest.mock('expo-router',()=>({...require('./helpers/mocks/expoRouter').makeMock(),usePathname:()=>mockPath,useGlobalSearchParams:()=>mockParams}));
jest.mock('../src/services/pentacleStream',()=>({
  consentConnection:()=>mockConnected?{scope:mockScope,host_id:'host',credential_id:'phone',generation:1}:null,
  usePentacleStreamSelector:(selector:any)=>selector({connected:mockConnected,notifications:mockRecords}),
}));
beforeEach(()=>{mockScope='host|phone';mockConnected=true;mockRecords=[];mockPath='/chats';mockParams={};jest.clearAllMocks();});
test('a pending request automatically presents on the root Agents surface and opens the exact request',()=>{
  mockRecords=[{notification_id:'consent:exact',consent:{request_id:'exact',host_id:'host',state:'pending'}}];
  const ui=render(<ConsentInbox/>);
  expect(ui.getByText('Approval requested')).toBeTruthy();
  fireEvent.press(ui.getByTestId('consent-inbox-open'));
  const route=(router.push as jest.Mock).mock.calls[0][0];
  expect(route).toEqual({pathname:'/approval',params:{kind:'approval',host_id:'host',request_id:'exact',gesture:expect.any(String)}});
  expect(consumeConsentGesture(route.params.gesture,{kind:'approval',host_id:'host',request_id:'exact'})).toBe(true);
  expect(consumeConsentGesture(route.params.gesture,{kind:'approval',host_id:'host',request_id:'exact'})).toBe(false);
});
test('receipt, foreign-host data and disconnect do not present a pending active claim',()=>{
  mockRecords=[{notification_id:'resolved',consent_offer:{offer_id:'offer',host_id:'host',state:'accepted',key_state:'active'}},
    {notification_id:'foreign',consent:{request_id:'other',host_id:'foreign',state:'pending'}}];
  const ui=render(<ConsentInbox/>);expect(ui.queryByTestId('consent-inbox')).toBeNull();
  mockRecords=[{notification_id:'pending',consent:{request_id:'exact',host_id:'host',state:'pending'}}];mockConnected=false;
  ui.rerender(<ConsentInbox/>);expect(ui.queryByTestId('consent-inbox')).toBeNull();
});
test('a consumed tap is invalid after a credential switch, and navigation cannot switch hosts',()=>{
  const hint={kind:'enrollment' as const,host_id:'host',request_id:'offer'};
  expect(navigateConsent(hint)).toBe(true);
  const route=(router.push as jest.Mock).mock.calls[0][0];mockScope='host|other-phone';
  expect(consumeConsentGesture(route.params.gesture,hint)).toBe(false);
  expect(navigateConsent({...hint,host_id:'other-host'})).toBe(false);
  expect(router.push).toHaveBeenCalledTimes(1);
});

test('a new approval presents while the completed enrollment request remains open',()=>{
  mockPath='/approval';mockParams={kind:'enrollment',host_id:'host',request_id:'old-offer'};
  mockRecords=[{notification_id:'old',consent_offer:{offer_id:'old-offer',host_id:'host',state:'accepted',key_state:'active'}},
    {notification_id:'new',consent:{request_id:'new-request',host_id:'host',state:'pending'}}];
  const ui=render(<ConsentInbox/>);expect(ui.getByText('Approval requested')).toBeTruthy();
  fireEvent.press(ui.getByTestId('consent-inbox-open'));
  expect(router.push).toHaveBeenCalledWith({pathname:'/approval',params:expect.objectContaining({request_id:'new-request',kind:'approval',host_id:'host'})});
});
test('only the exact request currently being reviewed is suppressed',()=>{
  mockPath='/approval';mockParams={kind:'approval',host_id:'host',request_id:'same'};
  mockRecords=[{notification_id:'same',consent:{request_id:'same',host_id:'host',state:'pending'}},
    {notification_id:'other',consent_offer:{offer_id:'offer',host_id:'host',state:'pending'}}];
  const ui=render(<ConsentInbox/>);expect(ui.getByText('Set up Approval key?')).toBeTruthy();
  mockRecords=mockRecords.slice(0,1);ui.rerender(<ConsentInbox/>);expect(ui.queryByTestId('consent-inbox')).toBeNull();
});
