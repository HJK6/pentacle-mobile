jest.mock('expo-constants', () => require('./helpers/stubs/expoConstants.cjs'));
class Socket {
 static CONNECTING=0; static OPEN=1; static CLOSED=3; static instances: Socket[]=[];
 readyState=0; sent: string[]=[]; onopen:(()=>void)|null=null;
 onmessage:((e:{data:string})=>void)|null=null; onclose:((e:unknown)=>void)|null=null; onerror:(()=>void)|null=null;
 constructor(public url:string){Socket.instances.push(this);}
 send(value:string){this.sent.push(value);}
 close(){this.readyState=3;this.onclose?.({code:1006});}
 open(){this.readyState=1;this.onopen?.();}
}
const DEFAULT_URL='ws://default.example/ws';
const ENROLLED_URL='ws://enrolled.example/ws';
const urls=()=>Socket.instances.map(s=>s.url);
function loadStream(){
 jest.resetModules(); Socket.instances=[];global.WebSocket=Socket as unknown as typeof WebSocket;
 jest.doMock('../src/config/pentacle',()=>({getDefaultPentacleWsUrl:()=>DEFAULT_URL}));
 const stream=require('../src/services/pentacleStream') as typeof import('../src/services/pentacleStream');
 const stop=stream.subscribePentacleStream(jest.fn());jest.advanceTimersByTime(0);
 return {stream,stop};
}
function enrolledStream(){
 const loaded=loadStream();
 loaded.stream.setPentacleWsUrl(ENROLLED_URL);
 return loaded;
}
beforeEach(()=>{jest.useFakeTimers();});
afterEach(()=>{jest.useRealTimers();});

test('reconnect after a socket drop targets the enrolled wsUrl, not the default',()=>{
 const {stream,stop}=enrolledStream();
 expect(Socket.instances.at(-1)!.url).toBe(ENROLLED_URL);
 Socket.instances.at(-1)!.open();
 Socket.instances.at(-1)!.close();
 jest.advanceTimersByTime(60_000);
 expect(Socket.instances.at(-1)!.url).toBe(ENROLLED_URL);
 stop();stream.__resetPentacleStreamForTests();
});

test('every reconnect attempt after failed reconnects keeps targeting the enrolled wsUrl',()=>{
 const {stream,stop}=enrolledStream();
 Socket.instances.at(-1)!.open();
 Socket.instances.at(-1)!.close();
 for(let i=0;i<4;i++){jest.advanceTimersByTime(60_000);Socket.instances.at(-1)!.close();}
 expect(urls().slice(1)).toEqual(Array(urls().length-1).fill(ENROLLED_URL));
 stop();stream.__resetPentacleStreamForTests();
});

test('an unreachable enrolled host keeps retrying the enrolled wsUrl with the enrolled-target error',()=>{
 const {stream,stop}=enrolledStream();
 for(let i=0;i<3;i++){Socket.instances.at(-1)!.onerror?.();Socket.instances.at(-1)!.close();jest.advanceTimersByTime(60_000);}
 expect(urls().length).toBeGreaterThan(2);
 expect(new Set(urls())).toEqual(new Set([ENROLLED_URL]));
 Socket.instances.at(-1)!.onerror?.();
 expect(stream.getPentacleStreamState().lastError).toBe(`Pentacle stream connection failed (${ENROLLED_URL})`);
 stop();stream.__resetPentacleStreamForTests();
});

test('an unenrolled phone connects and reconnects to the default wsUrl',()=>{
 const {stream,stop}=loadStream();
 expect(Socket.instances.at(-1)!.url).toBe(DEFAULT_URL);
 Socket.instances.at(-1)!.open();
 Socket.instances.at(-1)!.close();
 jest.advanceTimersByTime(60_000);
 Socket.instances.at(-1)!.close();
 jest.advanceTimersByTime(60_000);
 expect(urls().length).toBeGreaterThan(2);
 expect(new Set(urls())).toEqual(new Set([DEFAULT_URL]));
 stop();stream.__resetPentacleStreamForTests();
});
