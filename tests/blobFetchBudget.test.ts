import {acceptBlobChunk,newBlobFetchBudget,MAX_BLOB_CHUNKS,GENERIC_BLOB_MAX_BYTES} from '../src/services/blobFetchBudget';
test('generic budget remains 64 MiB, and managed budget can be narrower',()=>{
 expect(newBlobFetchBudget().maxBytes).toBe(64*1024*1024);
 const budget=newBlobFetchBudget(2);acceptBlobChunk(budget,'YQ==');acceptBlobChunk(budget,'Yg==');
 expect(()=>acceptBlobChunk(budget,'Yw==')).toThrow('blob_too_large');
});
test('empty frame flooding is bounded',()=>{
 const budget=newBlobFetchBudget(1);for(let i=0;i<MAX_BLOB_CHUNKS;i++)acceptBlobChunk(budget,'');
 expect(()=>acceptBlobChunk(budget,'')).toThrow('blob_too_large');
});
test.each(['a','====','AA!!','AAAA='])('invalid encoding %s is refused before decode',chunk=>{
 expect(()=>acceptBlobChunk(newBlobFetchBudget(),chunk)).toThrow('blob_invalid_encoding');
});
test.each([0,-1,NaN,GENERIC_BLOB_MAX_BYTES+1])('invalid limit %s refused',value=>{
 expect(()=>newBlobFetchBudget(value)).toThrow('Invalid blob byte budget');
});
