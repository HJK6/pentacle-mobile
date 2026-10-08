import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Constants from 'expo-constants';
import * as harnessRuntime from '../../../src/utils/harnessRuntime';
import { createCatalogLoader, getCatalogSpecId, keyFormatWidth, plainHttpUrl, reportIdGrammar, reportRequest, selectReports, validateCatalog, type Catalog, type ReportDescriptor } from '../../../src/features/dashboards/catalogLoader';
import type { PentacleReport } from '../../../src/services/pentacleAssets';

jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(), setItem: jest.fn() }));
jest.mock('expo-constants', () => ({ expoConfig: { extra: {} } }));
jest.mock('../../../src/utils/harnessRuntime', () => ({ getParam: jest.fn() }));
// Byte-for-byte HJK6/pentacle:test/fixtures/dashboard_catalog/catalog_cases.json
// SHA256 75596c04c268773653fb58da083ff74d4a82ef58fa784c48dc10d6cb536f69c4
const catalogCases = require('./fixtures/catalog_cases.json');
// Byte-for-byte HJK6/pentacle:test/fixtures/dashboard_catalog/report_retrieval_cases.json
// SHA256 ce4c8ec61ec42e2f8113310add075a2d73a71f3898ca8f102b9a20d58e9c0235
const retrieval = require('./fixtures/report_retrieval_cases.json');
const full = (): Catalog => JSON.parse(JSON.stringify(catalogCases.valid[0].catalog));
const meta = { asset_id: 'dashboard-catalog', content_type: 'dashboard-catalog', title: 'Example catalog', stream_id: 'hostx:example-catalog-owner' };
function harness() {
  const records = new Map<string, string>();
  const storage = { getItem: jest.fn(async (key: string) => records.get(key) || null), setItem: jest.fn(async (key: string, value: string) => { records.set(key, value); }) };
  const list = jest.fn(async () => [meta]), get = jest.fn(async () => ({ ...meta, body: JSON.stringify(full()) }));
  const loader = createCatalogLoader({ listReportsBySpec: list, getReportByOwner: get, storage, now: () => 1000 });
  return { loader, list, get, storage, records };
}
for (const item of catalogCases.valid) test(`catalog fixture valid: ${item.name}`, () => expect(validateCatalog(item.catalog)).toBe(item.catalog));
for (const item of catalogCases.invalid) test(`catalog fixture invalid: ${item.name}`, () => expect(() => validateCatalog(item.catalog)).toThrow(item.error));
for (const fixture of retrieval.cases) test(`shared retrieval fixture: ${fixture.name}`, () => {
  const descriptor = { ...retrieval.descriptor, ...fixture.descriptor } as ReportDescriptor;
  const rows = fixture.server_ids.map((asset_id: string) => ({ ...fixture.rows.find((row: PentacleReport) => row.asset_id === asset_id), asset_id, title: 'Example report', stream_id: 'hostx:example-producer' }));
  expect(reportRequest(descriptor)).toEqual(fixture.request);
  const outcome = selectReports(descriptor, rows);
  for (const [field, value] of Object.entries(fixture.outcome)) expect(outcome[field as keyof typeof outcome]).toEqual(value);
});
test('shared fixture bytes have exact documented source digests', () => {
  for (const [file, hash] of [['catalog_cases.json', '75596c04c268773653fb58da083ff74d4a82ef58fa784c48dc10d6cb536f69c4'], ['report_retrieval_cases.json', 'ce4c8ec61ec42e2f8113310add075a2d73a71f3898ca8f102b9a20d58e9c0235']]) expect(crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'fixtures', file))).digest('hex')).toBe(hash);
});
test('host API above one is unsupported including large integers, after whole-schema validation', async () => {
  const h = harness(), c = full(); c.requires.host_api = 9007199254740992; h.get.mockResolvedValue({ ...meta, body: JSON.stringify(c) });
  expect((await h.loader.refresh('example__catalog')).status).toBe('unsupported'); c.boards[0] = { ...c.boards[0], extra: true } as never;
  h.get.mockResolvedValue({ ...meta, body: JSON.stringify(c) }); expect((await h.loader.refresh('example__catalog')).status).toBe('malformed');
});
test('validator parity includes Unicode byte budget, uppercase schemes, optional title and fixed classes', () => {
  const c = full(); c.boards[0].name = '😀'.repeat(64); expect(() => validateCatalog(c)).not.toThrow();
  c.boards[0].name += '😀'; expect(() => validateCatalog(c)).toThrow();
  const big = full(); (big.boards[1] as {actions: string[]}).actions = Array(630).fill('assetList'); expect(() => validateCatalog(big)).toThrow('entry exceeds');
  expect(plainHttpUrl('HTTPS://viewer.example.test/app')).toBe(true);
  expect(plainHttpUrl('https://example.test/' + '😀'.repeat(1500))).toBe(true);
  for (const url of ['https:///x','http://:','https://example.test:99999','https://user@example.test','https://example.test/a b']) expect(plainHttpUrl(url)).toBe(false);
  expect(keyFormatWidth('[A-Z][0-9]{01}T\\.')).toBe(4);
  const grammar = reportIdGrammar('example.report-', '[A-Z]{2}\\.[0-9]', 2);
  expect(grammar.test('example.report-AB.1-r10')).toBe(true); expect(grammar.test('example.report-AB.1-r00')).toBe(false); expect(grammar.test('example.report-AB.1\n')).toBe(false);
  expect(reportIdGrammar('example-', '[0-9]{4}', 0).test('example-2026-r01')).toBe(false);
});
test('unset configuration does not initialize transport or call list/get', async () => {
  const h = harness(); expect((await h.loader.refresh()).status).toBe('unset'); expect(h.list).not.toHaveBeenCalled(); expect(h.get).not.toHaveBeenCalled();
});
test('discovery selects exact content type/id and forwards listed owner', async () => {
  const h = harness(); h.list.mockResolvedValue([{...meta,asset_id:'example-other'}, {...meta, content_type:'report'}, meta]);
  expect((await h.loader.refresh('example__catalog')).status).toBe('ready'); expect(h.list).toHaveBeenCalledTimes(1); expect(h.list).toHaveBeenCalledWith('example__catalog'); expect(h.get).toHaveBeenCalledWith(meta.stream_id, meta.asset_id, 'example__catalog');
});
test('unavailable without cache and invalid fetched catalog have exact visible cards', async () => {
  const h = harness(); h.list.mockRejectedValue(new Error('asset_unauthorized'));
  expect(await h.loader.refresh('example__catalog')).toMatchObject({status:'unavailable',catalog:null,cached:false,message:'Dashboard catalog unavailable: asset_unauthorized'});
  h.list.mockResolvedValue([meta]); h.get.mockResolvedValue({...meta,body:'{broken'});
  expect(await h.loader.refresh('example__catalog')).toMatchObject({status:'malformed',catalog:null,cached:false,message:expect.stringMatching(/^Dashboard catalog unsupported\/malformed: .*\(catalog unknown\)$/)});
});
test('bad fetch retains but never displays good cache until unavailable; cache is spec-scoped', async () => {
  const h = harness(); const good = await h.loader.refresh('example__catalog'); await h.loader.flush();
  h.get.mockResolvedValue({...meta,body:'{broken'}); expect((await h.loader.refresh('example__catalog')).catalog).toBeNull();
  const newer = full(); newer.requires.host_api = 2; h.get.mockResolvedValue({...meta,body:JSON.stringify(newer)}); expect((await h.loader.refresh('example__catalog')).catalog).toBeNull();
  h.get.mockRejectedValue(new Error('offline')); expect(await h.loader.refresh('example__catalog')).toMatchObject({cached:true,catalog:good.catalog,age:0}); expect((await h.loader.refresh('example__other')).catalog).toBeNull();
});
test('persisted cache is validated; denied storage still supports good memory cache', async () => {
  const h = harness(); await h.loader.refresh('example__catalog'); await h.loader.flush(); h.list.mockRejectedValue(new Error('offline'));
  const restored = createCatalogLoader({listReportsBySpec:h.list,getReportByOwner:h.get,storage:h.storage,now:()=>3000}); expect((await restored.refresh('example__catalog')).age).toBe(2000);
  h.records.set('dashboard-catalog:example__catalog','{broken'); expect((await createCatalogLoader({listReportsBySpec:h.list,storage:h.storage}).refresh('example__catalog')).catalog).toBeNull();
  const denied = harness(); denied.storage.setItem.mockRejectedValue(new Error('quota')); await denied.loader.refresh('example__catalog'); await denied.loader.flush(); denied.list.mockRejectedValue(new Error('offline')); expect((await denied.loader.refresh('example__catalog')).cached).toBe(true);
});
test('version replacement and cancellation are atomic including persisted writes', async () => {
  const h = harness(); await h.loader.refresh('example__catalog'); const next = full(); next.catalog_version = '0.2.1+bbbbbbb'; h.get.mockResolvedValue({...meta,body:JSON.stringify(next)}); await h.loader.refresh('example__catalog'); await h.loader.flush();
  expect(JSON.parse(h.records.get('dashboard-catalog:example__catalog')!).catalog.catalog_version).toBe(next.catalog_version);
  let resolve!: (v: typeof meta & {body:string}) => void; h.get.mockImplementation(()=>new Promise(r=>{resolve=r;})); const pending=h.loader.refresh('example__catalog'); await Promise.resolve(); h.loader.cancel(); resolve({...meta,body:JSON.stringify(full())}); expect((await pending).status).toBe('superseded'); h.list.mockRejectedValue(new Error('offline')); expect((await h.loader.refresh('example__catalog')).catalog?.catalog_version).toBe(next.catalog_version);
});
test('production ignores harness override; harness empty value explicitly unsets baked config', () => {
  const before=process.env.EXPO_PUBLIC_HARNESS; (Constants.expoConfig!.extra as Record<string,unknown>).dashboardCatalogSpecId='example__baked';
  try { process.env.EXPO_PUBLIC_HARNESS='0'; (harnessRuntime.getParam as jest.Mock).mockReturnValue('example__override'); expect(getCatalogSpecId()).toBe('example__baked'); process.env.EXPO_PUBLIC_HARNESS='1'; expect(getCatalogSpecId()).toBe('example__override'); (harnessRuntime.getParam as jest.Mock).mockReturnValue(''); expect(getCatalogSpecId()).toBeUndefined(); } finally { process.env.EXPO_PUBLIC_HARNESS=before; }
});
test('partial headers, raw ordering, writer guarantees and optional producer stay generic', () => {
  const report={...retrieval.descriptor,history_limit:1,writer_enforced:false} as ReportDescriptor;
  const rows=[4,3,2,1].map(n=>({asset_id:`example-report-20261004T1300Z-r0${n}`,title:'Example',content_type:'report',updated_at:`2000-01-0${n}`}));
  expect(selectReports(report,rows)).toMatchObject({state:'partial',latest:rows[0].asset_id,header:'latest in loaded window',truncated:false}); expect(selectReports({...report,writer_enforced:true},rows).header).toBe('latest'); expect(selectReports(report,[]).state).toBe('empty');
  const absent={...report}; delete absent.producer_stream_id; expect(reportRequest(absent)).not.toHaveProperty('producer'); expect(reportRequest({...report,history_limit:100}).limit).toBe(400);
});
test('slow persisted-cache read cannot replace newer validated memory catalog', async () => {
  const h=harness(), old=full(), next=full(); next.catalog_version='0.2.1+bbbbbbb';
  let resolve!: (s: string|null) => void; h.storage.getItem.mockImplementationOnce(()=>new Promise(r=>{resolve=r;})); h.list.mockRejectedValueOnce(new Error('offline'));
  const stale=h.loader.refresh('example__catalog'); await Promise.resolve(); await Promise.resolve();
  h.get.mockResolvedValue({...meta,body:JSON.stringify(next)}); expect((await h.loader.refresh('example__catalog')).status).toBe('ready');
  resolve(JSON.stringify({catalog:old,savedAt:0})); expect((await stale).status).toBe('superseded'); h.list.mockRejectedValue(new Error('offline'));
  expect((await h.loader.refresh('example__catalog')).catalog?.catalog_version).toBe(next.catalog_version);
});
