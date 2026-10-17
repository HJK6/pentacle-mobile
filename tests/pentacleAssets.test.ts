const mockSendCommand = jest.fn();
let mockAssetFrame: ((message: Record<string, unknown>) => void) | null = null;
const mockPush = jest.fn();

jest.mock('expo-router', () => ({ router: { push: (...args: unknown[]) => mockPush(...args) } }));
jest.mock('../src/services/pentacleStream', () => ({
  sendPentacleAssetCommand: (...args: unknown[]) => mockSendCommand(...args),
  subscribePentacleAssetFrames: (listener: (message: Record<string, unknown>) => void) => {
    mockAssetFrame = listener;
    return () => { mockAssetFrame = null; };
  },
}));

import {
  __resetPentacleAssetsForTests,
  __handlePentacleAssetFrameForTests,
  addReportComment,
  deleteReport,
  deleteReportComment,
  getReport,
  getSessionReports,
  isReportSessionClosed,
  listReportComments,
  listReports,
  markReportRead,
  openReports,
  selectSessionReportAction,
  sendReportCommentsToChat,
} from '../src/services/pentacleAssets';

const STREAM = 'hostc:report-chat';
const report = {
  asset_id: 'report-1',
  title: 'Newest report',
  content_type: 'report',
  read: false,
  read_at: null,
  updated_at: '2026-07-11T10:00:00Z',
};

beforeEach(() => {
  mockSendCommand.mockReset();
  mockPush.mockReset();
  __resetPentacleAssetsForTests();
});

test('asset.list keeps only reports, sorts latest-first, and derives daemon unread', async () => {
  mockSendCommand.mockResolvedValueOnce({
    type: 'asset.list.ok',
    assets: [
      { ...report, asset_id: 'older', title: 'Older', updated_at: '2026-07-10T10:00:00Z' },
      report,
      { asset_id: 'note-1', title: 'Note', content_type: 'markdown' },
    ],
  });

  await expect(listReports(STREAM)).resolves.toEqual([
    expect.objectContaining({ asset_id: 'report-1' }),
    expect.objectContaining({ asset_id: 'older' }),
  ]);
  expect(mockSendCommand).toHaveBeenCalledWith({ type: 'asset.list', stream_id: STREAM, content_type: 'report' });
  expect(selectSessionReportAction(STREAM)).toEqual({ hasReports: true, reportUnread: true });
});

test('missing read contract never creates a test-device unread shadow', async () => {
  mockSendCommand.mockResolvedValueOnce({ type: 'asset.list.ok', assets: [{ ...report, read: undefined, read_at: undefined }] });
  await listReports(STREAM);
  expect(selectSessionReportAction(STREAM)).toEqual({ hasReports: true, reportUnread: false });
});

test('descendant report actions target its owner and keep duplicate ids independent', async () => {
  const child = { ...report, stream_id: 'hostb:child' };
  const own = { ...report, stream_id: STREAM };
  mockSendCommand.mockResolvedValueOnce({ type: 'asset.list.ok', scope_stream_ids: [STREAM, 'hostb:child'], assets: [own, child] });
  await listReports(STREAM);
  mockSendCommand.mockResolvedValueOnce({ asset: { ...child, body: 'child' } });
  await getReport(STREAM, child);
  expect(mockSendCommand).toHaveBeenLastCalledWith({ type: 'asset.get', stream_id: 'hostb:child', asset_id: child.asset_id });
  expect(getSessionReports(STREAM)).toHaveLength(2);
  mockSendCommand.mockResolvedValueOnce({});
  await deleteReport(STREAM, child);
  expect(mockSendCommand).toHaveBeenLastCalledWith({ type: 'asset.delete', stream_id: 'hostb:child', asset_id: child.asset_id });
  expect(getSessionReports(STREAM)).toEqual([own]);
});

test('newer chat lists and in-flight report pushes win over older snapshots', async () => {
  let oldResolve!: (value: unknown) => void;
  let newResolve!: (value: unknown) => void;
  mockSendCommand.mockImplementationOnce(() => new Promise(resolve => { oldResolve = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { newResolve = resolve; }));
  const old = listReports(STREAM);
  const fresh = listReports(STREAM);
  newResolve({ assets: [{ ...report, title: 'new' }] });
  await fresh;
  oldResolve({ assets: [{ ...report, title: 'old' }] });
  await old;
  expect(getSessionReports(STREAM)[0].title).toBe('new');

  mockSendCommand.mockImplementationOnce(() => new Promise(resolve => { oldResolve = resolve; }));
  const inflight = listReports(STREAM);
  __handlePentacleAssetFrameForTests({ type:'asset.update', ...report, title:'live', stream_id:STREAM });
  oldResolve({ assets: [] });
  await inflight;
  expect(getSessionReports(STREAM)[0].title).toBe('live');

  mockSendCommand.mockImplementationOnce(() => new Promise(resolve => { oldResolve = resolve; }));
  const removed = listReports(STREAM);
  __handlePentacleAssetFrameForTests({ type:'asset.removed', asset_id:report.asset_id, stream_id:STREAM });
  oldResolve({ assets:[report] });
  await removed;
  expect(getSessionReports(STREAM)).toEqual([]);
});

test('binding changes retire the previous scope and refresh through asset.list', async () => {
  mockSendCommand.mockResolvedValueOnce({ scope_stream_ids:[STREAM,'hostb:old'], assets:[{...report,stream_id:'hostb:old'}] });
  await listReports(STREAM);
  let resolve!: (reply: unknown) => void;
  mockSendCommand.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  __handlePentacleAssetFrameForTests({type:'assistant.binding.changed',stream_id:'hostb:new'});
  expect(getSessionReports(STREAM)).toEqual([]);
  resolve({scope_stream_ids:[STREAM,'hostb:new'],assets:[{...report,stream_id:'hostb:new'}]});
  await new Promise(done => setImmediate(done));
  expect(getSessionReports(STREAM)[0].stream_id).toBe('hostb:new');
});

test('binding rotation invalidates the first pending list and late detail/read replies', async () => {
  const pending: Array<{ payload: Record<string, unknown>; resolve: (reply: unknown) => void }> = [];
  mockSendCommand.mockImplementation(payload => new Promise(resolve => pending.push({ payload, resolve })));
  const first = listReports(STREAM);
  const old = pending[0];
  __handlePentacleAssetFrameForTests({type:'assistant.binding.changed',stream_id:'hostb:new'});
  expect(pending).toHaveLength(2);
  const fresh = pending[1];
  old.resolve({scope_stream_ids:[STREAM,'hostb:old'],assets:[{...report,stream_id:'hostb:old'}]});
  await first;
  expect(getSessionReports(STREAM)).toEqual([]);
  fresh.resolve({scope_stream_ids:[STREAM,'hostb:new'],assets:[{...report,stream_id:'hostb:new'}]});
  await new Promise(done => setImmediate(done));
  const detail = getReport(STREAM, {...report,stream_id:'hostb:new'});
  const detailReply = pending.at(-1)!;
  const read = markReportRead(STREAM, {...report,stream_id:'hostb:new'});
  const readReply = pending.at(-1)!;
  __handlePentacleAssetFrameForTests({type:'assistant.binding.changed',stream_id:'hostb:latest'});
  pending.at(-1)!.resolve({scope_stream_ids:[STREAM,'hostb:latest'],assets:[{...report,stream_id:'hostb:latest'}]});
  await new Promise(done => setImmediate(done));
  detailReply.resolve({asset:{...report,stream_id:'hostb:new'}});
  readReply.resolve({asset:{...report,stream_id:'hostb:new',read:true}});
  await detail; await read;
  expect(getSessionReports(STREAM).map(item => item.stream_id)).toEqual(['hostb:latest']);
});

test('canonical get/comment/add/delete/send/read/delete RPCs preserve anchors and spec_id', async () => {
  const specReport = { ...report, spec_id: 'spec-report', body: '{"schema_version":1,"title":"R","sections":[]}' };
  const comment = {
    comment_id: 'comment-1',
    asset_id: report.asset_id,
    section_id: 'section-1',
    block_id: 'block-1',
    excerpt: 'Anchor',
    body: 'Please change this',
    author: 'user@example.com',
  };
  mockSendCommand
    .mockResolvedValueOnce({ type: 'asset.get.ok', asset: specReport })
    .mockResolvedValueOnce({ type: 'asset.comments.list.ok', comments: [comment] })
    .mockResolvedValueOnce({ type: 'asset.comment.add.ok', comment })
    .mockResolvedValueOnce({ type: 'asset.comment.delete.ok', comment })
    .mockResolvedValueOnce({ type: 'asset.comments.send_to_chat.ok', sent: 1 })
    .mockResolvedValueOnce({ type: 'asset.read.set.ok', asset: { ...specReport, read: true, read_at: 'now' } })
    .mockResolvedValueOnce({ type: 'asset.delete.ok', asset_id: report.asset_id });

  await getReport(STREAM, specReport);
  await listReportComments(STREAM, specReport);
  await addReportComment({ streamId: STREAM, report: specReport, sectionId: 'section-1', blockId: 'block-1', excerpt: 'Anchor', body: ' Please change this ' });
  await deleteReportComment(STREAM, specReport, 'comment-1');
  await sendReportCommentsToChat(STREAM, specReport);
  await markReportRead(STREAM, specReport);
  await deleteReport(STREAM, specReport);

  expect(mockSendCommand.mock.calls.map(([payload]) => payload)).toEqual([
    { type: 'asset.get', stream_id: STREAM, asset_id: 'report-1', spec_id: 'spec-report' },
    { type: 'asset.comments.list', stream_id: STREAM, asset_id: 'report-1', spec_id: 'spec-report' },
    { type: 'asset.comment.add', stream_id: STREAM, asset_id: 'report-1', section_id: 'section-1', block_id: 'block-1', excerpt: 'Anchor', body: 'Please change this', spec_id: 'spec-report' },
    { type: 'asset.comment.delete', stream_id: STREAM, asset_id: 'report-1', comment_id: 'comment-1', spec_id: 'spec-report' },
    { type: 'asset.comments.send_to_chat', stream_id: STREAM, asset_id: 'report-1', spec_id: 'spec-report' },
    { type: 'asset.read.set', stream_id: STREAM, asset_id: 'report-1', read: true, spec_id: 'spec-report' },
    { type: 'asset.delete', stream_id: STREAM, asset_id: 'report-1', spec_id: 'spec-report' },
  ]);
  expect(getSessionReports(STREAM)).toEqual([]);
});

test('asset.update clears unread live and asset.removed removes the report', async () => {
  mockSendCommand.mockResolvedValueOnce({ type: 'asset.list.ok', assets: [report] });
  await listReports(STREAM);

  __handlePentacleAssetFrameForTests({
    type: 'asset.update',
    session_key: { stream_id: STREAM, host: 'hostc', session_name: 'report-chat' },
    ...report,
    read: true,
    read_at: '2026-07-11T10:05:00Z',
  });
  expect(selectSessionReportAction(STREAM)).toEqual({ hasReports: true, reportUnread: false });

  __handlePentacleAssetFrameForTests({ type: 'asset.removed', stream_id: STREAM, asset_id: report.asset_id });
  expect(selectSessionReportAction(STREAM)).toEqual({ hasReports: false, reportUnread: false });
});

test('asset.session_closed preserves readable reports and marks the surface read-only', async () => {
  mockSendCommand.mockResolvedValueOnce({ type: 'asset.list.ok', assets: [report] });
  await listReports(STREAM);
  __handlePentacleAssetFrameForTests({ type: 'asset.session_closed', stream_id: STREAM });
  expect(isReportSessionClosed(STREAM)).toBe(true);
  expect(getSessionReports(STREAM)).toHaveLength(1);
});

test('openReports refreshes inventory then routes through the locked adapter', async () => {
  mockSendCommand.mockResolvedValueOnce({ type: 'asset.list.ok', assets: [report] });
  await openReports(STREAM);
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/pentacle/session/[streamId]', params: { streamId: STREAM, reports: '1' } });
});
