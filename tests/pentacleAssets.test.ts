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

