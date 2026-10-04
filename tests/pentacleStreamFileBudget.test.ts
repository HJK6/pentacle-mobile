const mockWrite = jest.fn();
const mockShare = jest.fn();
jest.mock('expo-file-system/legacy', () => ({
 cacheDirectory: 'file:///synthetic-cache/', EncodingType: { Base64: 'base64' },
 makeDirectoryAsync: jest.fn(), writeAsStringAsync: (...args: unknown[]) => mockWrite(...args),
 readAsStringAsync: jest.fn(), deleteAsync: jest.fn(),
}));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn().mockResolvedValue(true), shareAsync: (...args: unknown[]) => mockShare(...args) }));
class Socket {
 static CONNECTING=0; static OPEN=1; static CLOSED=3; static instances: Socket[]=[];
 readyState=0; sent: string[]=[]; onopen:(()=>void)|null=null;
 onmessage:((e:{data:string})=>void)|null=null; onclose:((e:unknown)=>void)|null=null;
 constructor(public url:string){Socket.instances.push(this);}
 send(value:string){this.sent.push(value);}
 close(){this.readyState=3;this.onclose?.({code:1000});}
 open(){this.readyState=1;this.onopen?.();}
 frame(value:unknown){this.onmessage?.({data:JSON.stringify(value)});}
}
function connect(){
 jest.resetModules(); Socket.instances=[];global.WebSocket=Socket as unknown as typeof WebSocket;
 jest.doMock('../src/config/pentacle',()=>({getDefaultPentacleWsUrl:()=> 'ws://synthetic-budget.example/ws'}));
 const stream=require('../src/services/pentacleStream') as typeof import('../src/services/pentacleStream');
 const stop=stream.subscribePentacleStream(jest.fn());jest.advanceTimersByTime(0);
 const socket=Socket.instances[0];socket.open();return {stream,socket,stop};
}
beforeEach(()=>{jest.useFakeTimers();jest.clearAllMocks();});
afterEach(()=>{jest.useRealTimers();});
async function flush(){for(let i=0;i<10;i++)await Promise.resolve();}

test('oversized multi-chunk file settles before assembly, disk write or native share; late frames ignored',async()=>{
 const {stream,socket,stop}=connect();
 const decode=jest.spyOn(require('base64-js'),'toByteArray');decode.mockClear();
 const {downloadAndShareAttachment}=require('../src/services/fileAttachmentShare');
 const pending=downloadAndShareAttachment({key:'a'.repeat(64),mime:'application/pdf',size:25*1024*1024,filename:'synthetic.pdf'});
 const outcome=pending.catch((e:Error)=>e);await flush();
 const request=socket.sent.map(s=>JSON.parse(s)).find(x=>x.type==='fetch_blob');expect(request).toBeDefined();
 const chunk=Buffer.alloc(1024*1024).toString('base64');
 for(let n=0;n<26;n++)socket.frame({type:'fetch_blob.chunk',request_id:request.request_id,content_b64:chunk});
 expect(await outcome).toMatchObject({code:'file_fetch_failed'});
 socket.frame({type:'fetch_blob.ok',request_id:request.request_id,content_b64:chunk,blob_sha:'a'.repeat(64),size_bytes:1});
 expect(decode).not.toHaveBeenCalled();expect(mockWrite).not.toHaveBeenCalled();expect(mockShare).not.toHaveBeenCalled();
 decode.mockRestore();stop();stream.__resetPentacleStreamForTests();
});

test('final frame is budgeted as well as intermediate chunks',async()=>{
 const {stream,socket,stop}=connect();
 const pending=stream.fetchBlobBase64('b'.repeat(64),{maxBytes:3});const outcome=pending.catch(e=>e);
 const request=JSON.parse(socket.sent.at(-1)!);
 socket.frame({type:'fetch_blob.chunk',request_id:request.request_id,content_b64:'YWI='});
 socket.frame({type:'fetch_blob.ok',request_id:request.request_id,content_b64:'Y2Q=',size_bytes:3});
 expect(await outcome).toMatchObject({code:'blob_too_large'});
 stop();stream.__resetPentacleStreamForTests();
});

test('independently padded chunks at exact budget still assemble correctly',async()=>{
 const {stream,socket,stop}=connect();
 const pending=stream.fetchBlobBase64('b'.repeat(64),{maxBytes:4});
 const request=JSON.parse(socket.sent.at(-1)!);
 socket.frame({type:'fetch_blob.chunk',request_id:request.request_id,content_b64:'YWI='});
 socket.frame({type:'fetch_blob.ok',request_id:request.request_id,content_b64:'Y2Q=',size_bytes:4});
 expect((await pending).content_b64).toBe('YWJjZA==');
 stop();stream.__resetPentacleStreamForTests();
});
