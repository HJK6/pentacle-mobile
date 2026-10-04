const mockFetch = jest.fn();
const mockAvailable = jest.fn();
const mockShare = jest.fn();
const mockWrite = jest.fn();
const mockRead = jest.fn();
const mockDelete = jest.fn();
jest.mock('../src/services/pentacleStream',()=>({fetchBlobBase64:(...args:unknown[])=>mockFetch(...args)}));
jest.mock('expo-sharing',()=>({isAvailableAsync:()=>mockAvailable(),shareAsync:(...args:unknown[])=>mockShare(...args)}));
jest.mock('expo-file-system/legacy',()=>({cacheDirectory:'file:///cache/',makeDirectoryAsync:jest.fn().mockResolvedValue(undefined),writeAsStringAsync:(...args:unknown[])=>mockWrite(...args),readAsStringAsync:(...args:unknown[])=>mockRead(...args),deleteAsync:(...args:unknown[])=>mockDelete(...args),EncodingType:{Base64:'base64'}}));
import { downloadAndShareAttachment } from '../src/services/fileAttachmentShare';
import { createHash } from 'crypto';
const body=Buffer.from('%PDF synthetic mobile file');
const key=createHash('sha256').update(body).digest('hex');
const attachment={key,mime:'application/pdf',size:body.length,filename:'sample.pdf'};
beforeEach(()=>{
 jest.clearAllMocks();mockAvailable.mockResolvedValue(true);mockShare.mockResolvedValue(undefined);
 mockFetch.mockResolvedValue({blob_sha:key,size_bytes:body.length,content_b64:body.toString('base64')});
 mockRead.mockResolvedValue(body.toString('base64'));mockWrite.mockResolvedValue(undefined);mockDelete.mockResolvedValue(undefined);
});
test('authenticated fetched bytes are verified, written and read back before native sharing',async()=>{
 await downloadAndShareAttachment(attachment);
 expect(mockFetch).toHaveBeenCalledWith(key, { maxBytes: body.length });
 expect(mockWrite.mock.calls[0][1]).toBe(body.toString('base64'));
 expect(mockRead).toHaveBeenCalled();
 expect(mockShare).toHaveBeenCalledWith(expect.stringMatching(/sample\.pdf$/),expect.objectContaining({mimeType:'application/pdf'}));
 expect(mockDelete).toHaveBeenCalled();
});
test('mismatched digest never reaches native sharing',async()=>{
 mockFetch.mockResolvedValue({blob_sha:key,size_bytes:body.length,content_b64:Buffer.from('X'.repeat(body.length)).toString('base64')});
 await expect(downloadAndShareAttachment(attachment)).rejects.toThrow();
 expect(mockShare).not.toHaveBeenCalled();expect(mockWrite).not.toHaveBeenCalled();
});

test.each(['application/zip','model/3mf','model/stl','model/step','application/x-openscad'])('supported %s shares with its canonical MIME',async(mime)=>{
 await downloadAndShareAttachment({...attachment,mime,filename:'synthetic'});
 expect(mockShare).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({mimeType:mime}));
});
test.each(['text/html','image/svg+xml','__proto__','constructor'])('unsupported %s never fetches or shares',async(mime)=>{
 await expect(downloadAndShareAttachment({...attachment,mime})).rejects.toThrow('attachment_invalid');
 expect(mockFetch).not.toHaveBeenCalled();expect(mockShare).not.toHaveBeenCalled();
});
test.each([0,-1,25*1024*1024+1,NaN])('invalid size %s is refused before fetch',async(size)=>{
 await expect(downloadAndShareAttachment({...attachment,size})).rejects.toThrow('attachment_invalid');
 expect(mockFetch).not.toHaveBeenCalled();
});
test('server unavailable stays distinct from a temporary fetch failure',async()=>{
 mockFetch.mockRejectedValueOnce(Object.assign(new Error('missing'),{code:'blob_unknown'}));
 await expect(downloadAndShareAttachment(attachment)).rejects.toMatchObject({code:'blob_unknown'});
 mockFetch.mockRejectedValueOnce(new Error('temporary'));
 await expect(downloadAndShareAttachment(attachment)).rejects.toMatchObject({code:'file_fetch_failed'});
 expect(mockShare).not.toHaveBeenCalled();
});
test('corrupted disk readback refuses sharing and cleans owned temporary files',async()=>{
 mockRead.mockResolvedValueOnce('AA==');
 await expect(downloadAndShareAttachment(attachment)).rejects.toThrow();
 expect(mockShare).not.toHaveBeenCalled();expect(mockDelete).toHaveBeenCalled();
});
test('every user request reauthorizes rather than trusting cached bytes or a supplied URI',async()=>{
 await downloadAndShareAttachment({...attachment,uri:'file:///untrusted'} as any);
 await downloadAndShareAttachment(attachment);
 expect(mockFetch).toHaveBeenCalledTimes(2);
 expect(mockWrite.mock.calls[0][0]).not.toBe(mockWrite.mock.calls[1][0]);
 expect(mockShare.mock.calls[0][0]).not.toContain('untrusted');
});
test('a cancelled request cannot open the native share sheet after fetch resolves',async()=>{
 const controller=new AbortController();
 mockFetch.mockImplementationOnce(async()=>{controller.abort();return {blob_sha:key,size_bytes:body.length,content_b64:body.toString('base64')};});
 await expect(downloadAndShareAttachment(attachment,controller.signal)).rejects.toMatchObject({code:'cancelled'});
 expect(mockShare).not.toHaveBeenCalled();
});
test('no OS sharing capability fails without fetching bytes',async()=>{
 mockAvailable.mockResolvedValue(false);
 await expect(downloadAndShareAttachment(attachment)).rejects.toMatchObject({code:'sharing_unavailable'});
 expect(mockFetch).not.toHaveBeenCalled();
});
