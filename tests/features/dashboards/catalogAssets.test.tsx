const mockSend = jest.fn();
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('../../../src/services/pentacleStream', () => ({ sendPentacleAssetCommand: (...args: unknown[]) => mockSend(...args), subscribePentacleAssetFrames: () => () => {} }));
import { listReportsBySpec, getReportByOwner, getSessionReports, __resetPentacleAssetsForTests } from '../../../src/services/pentacleAssets';
import { buildExpoExtra } from '../../../app.config';
import exampleConfig from '../../../pentacle.config.example';

beforeEach(() => { mockSend.mockReset(); __resetPentacleAssetsForTests(); });
test('spec list forwards exact optional window fields, preserves raw order and all content types', async () => {
  const assets = [ { asset_id:'example-report-20261007T1300Z',title:'Example',content_type:'report',updated_at:'2000' }, {asset_id:'dashboard-catalog',title:'Example Catalog',content_type:'dashboard-catalog',updated_at:'2099'} ];
  mockSend.mockResolvedValue({assets});
  expect(await listReportsBySpec('example__reports',{assetIdPrefix:'example-report-',producer:'hostx:example-producer',sort:'asset_id_desc',limit:12})).toBe(assets);
  expect(mockSend).toHaveBeenCalledTimes(1); expect(mockSend).toHaveBeenCalledWith({type:'asset.list',spec_id:'example__reports',asset_id_prefix:'example-report-',producer:'hostx:example-producer',sort:'asset_id_desc',limit:12});
  expect(getSessionReports('hostx:example-producer')).toEqual([]);
});
test('discovery list omits window and report-only filters', async () => {
  mockSend.mockResolvedValue({assets:[]}); await listReportsBySpec('example__catalog'); expect(mockSend).toHaveBeenCalledWith({type:'asset.list',spec_id:'example__catalog'});
});
test('get preserves listed owner and spec; no comments/read/list/auth fallback is issued', async () => {
  const asset={asset_id:'example-report-20261007T1300Z',title:'Example',content_type:'report',body:'{}'}; mockSend.mockResolvedValue({asset});
  expect(await getReportByOwner('hostx:example-producer',asset.asset_id,'example__reports')).toBe(asset);
  expect(mockSend.mock.calls).toEqual([[{type:'asset.get',stream_id:'hostx:example-producer',asset_id:asset.asset_id,spec_id:'example__reports'}]]);
  expect(getSessionReports('hostx:example-producer')).toEqual([]);
});
test('exact fixture-daemon denial propagates and stops without another request', async () => {
  const error=new Error('asset_unauthorized'); mockSend.mockRejectedValue(error);
  await expect(getReportByOwner('hostx:example-producer','example-report-20261007T1300Z','example__reports')).rejects.toBe(error); expect(mockSend).toHaveBeenCalledTimes(1);
});
test('missing or refused replies fail visibly', async () => {
  mockSend.mockResolvedValue({}); await expect(listReportsBySpec('example__catalog')).rejects.toThrow('asset.list returned no assets'); await expect(getReportByOwner('hostx:example-producer','example-report','example__reports')).rejects.toThrow('Report was not returned');
  mockSend.mockResolvedValue({ok:false,error:'asset_unauthorized'}); await expect(listReportsBySpec('example__catalog')).rejects.toThrow('asset_unauthorized');
});
test('Expo extra carries optional local catalog setting as build configuration', () => {
  const extra=buildExpoExtra({...exampleConfig,dashboardCatalogSpecId:'example__catalog'},'wss://example.test'); expect(extra.dashboardCatalogSpecId).toBe('example__catalog');
  expect(buildExpoExtra(exampleConfig,'wss://example.test').dashboardCatalogSpecId).toBeUndefined();
});
