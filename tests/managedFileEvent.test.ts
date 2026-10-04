import {
 applyFetchedStreamEvents, applyPentacleEvent, applyPentacleSnapshotMessage,
 initialPentacleStreamState, interpretPentacleEvent, selectSessionDetail,
 type PentacleEvent, type PentacleSessionSummary, type PentacleStreamState,
} from 'pentacle-chat-core';
const stream='fixture:file-chat';
const session:PentacleSessionSummary={stream_id:stream,host:'fixture',provider:'composite',session_name:'file-chat',last_event_at:'2026-01-01T00:00:00Z',last_text:'',last_kind:'',draft:'',pending:false,working:false,online:true};
function seeded():PentacleStreamState{return {...initialPentacleStreamState,connected:true,sessions:[session]};}
const event:PentacleEvent={daemon_seq:7,host:'fixture',provider:'composite',session_id:stream,session_name:'file-chat',stream_id:stream,timestamp:'2026-01-01T00:00:00Z',kind:'ASSIST_TEXT',text:'',attachments:[{key:'a'.repeat(64),mime:'application/pdf',filename:'synthetic.pdf',size:22,upload_id:'synthetic-upload'}],raw:{assistant_composite:true}};
test('attachment-only managed file is visible without an empty-caption noise exemption bypass in the view',()=>{
 expect(interpretPentacleEvent(event).displayRule).toBe('bubble:assistant');
});
test.each(['live','history','snapshot'])('managed metadata survives %s and replay as one row',(lane)=>{
 let state=lane==='live'?applyPentacleEvent(seeded(),event):lane==='history'?applyFetchedStreamEvents(seeded(),[event],500,stream):applyPentacleSnapshotMessage(seeded(),{events:[event],sessions:[session]});
 state=applyPentacleEvent(state,event);
 const rows=selectSessionDetail(state,stream,{visibleCount:'all'})?.transcriptItems.filter(i=>i.attachments?.length)||[];
 expect(rows).toHaveLength(1);expect(rows[0].attachments).toEqual(event.attachments);
});
