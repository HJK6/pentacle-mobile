import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import { Image } from 'react-native';
const mockShare = jest.fn();
jest.mock('../src/services/fileAttachmentShare',()=>({
 downloadAndShareAttachment:(...args:unknown[])=>mockShare(...args),
 FILE_ATTACHMENT_MAX_BYTES:25*1024*1024,
 fileType:(mime:string)=>mime==='application/pdf'?{extension:'pdf'}:undefined,
 fileDisplayName:(a:any)=>a.filename || 'attachment.pdf',
}));
import { AttachmentBubble } from '../src/components/AttachmentBubble';
const attachment={key:'a'.repeat(64),mime:'application/pdf',size:12,filename:'synthetic.pdf'};
const props={kind:'file' as const,attachment,uri:'',testID:'fixture-file',borderColor:'#444',onPress:jest.fn()};
beforeEach(()=>{jest.clearAllMocks();mockShare.mockResolvedValue(undefined);});
test('file bubble shows name/type/size and never invokes the image viewer',async()=>{
 const ui=render(<AttachmentBubble {...props}/>);
 expect(ui.getByText('synthetic.pdf')).toBeTruthy();
 expect(ui.getByText('application/pdf · 12 bytes')).toBeTruthy();
 expect(ui.UNSAFE_queryByType(Image)).toBeNull();
 fireEvent.press(ui.getByTestId('fixture-file-file-share'));
 await waitFor(()=>expect(mockShare).toHaveBeenCalledWith(attachment,expect.anything()));
 await waitFor(()=>expect(ui.getByText('Save a copy or share')).toBeTruthy());
 expect(props.onPress).not.toHaveBeenCalled();
});
test('missing server blob displays unavailable and disables repeated sharing',async()=>{
 mockShare.mockRejectedValueOnce(Object.assign(new Error('missing'),{code:'blob_unknown'}));
 const ui=render(<AttachmentBubble {...props}/>);
 fireEvent.press(ui.getByTestId('fixture-file-file-share'));
 await waitFor(()=>expect(ui.getByText('File expired or unavailable')).toBeTruthy());
 fireEvent.press(ui.getByTestId('fixture-file-file-share'));
 expect(mockShare).toHaveBeenCalledTimes(1);
});
test('temporary failure remains retryable',async()=>{
 mockShare.mockRejectedValueOnce(new Error('temporary'));
 const ui=render(<AttachmentBubble {...props}/>);
 fireEvent.press(ui.getByTestId('fixture-file-file-share'));
 await waitFor(()=>expect(ui.getByText('Download failed. Tap to retry')).toBeTruthy());
 fireEvent.press(ui.getByTestId('fixture-file-file-share'));
 await waitFor(()=>expect(mockShare).toHaveBeenCalledTimes(2));
});
test('busy action is single-flight and unmount aborts pending native sharing',async()=>{
 let done!:()=>void;mockShare.mockImplementationOnce(()=>new Promise<void>(r=>{done=r;}));
 const ui=render(<AttachmentBubble {...props}/>);
 fireEvent.press(ui.getByTestId('fixture-file-file-share'));fireEvent.press(ui.getByTestId('fixture-file-file-share'));
 expect(mockShare).toHaveBeenCalledTimes(1);
 const signal=mockShare.mock.calls[0][1];ui.unmount();expect(signal.aborted).toBe(true);
 await act(async()=>done());
});
test('unsupported active type is inert',()=>{
 const ui=render(<AttachmentBubble {...props} attachment={{...attachment,mime:'text/html'}}/>);
 expect(ui.getByText('Unsupported attachment')).toBeTruthy();
 fireEvent.press(ui.getByTestId('fixture-file-file-share'));expect(mockShare).not.toHaveBeenCalled();
});
test('incomplete historical file metadata cannot advertise an actionable download',()=>{
 const ui=render(<AttachmentBubble {...props} attachment={{...attachment,size:undefined}}/>);
 expect(ui.getByText('Unsupported attachment')).toBeTruthy();
 fireEvent.press(ui.getByTestId('fixture-file-file-share'));expect(mockShare).not.toHaveBeenCalled();
});
