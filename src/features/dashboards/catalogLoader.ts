import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as harnessRuntime from '../../utils/harnessRuntime';
import type { listReportsBySpec, getReportByOwner, PentacleReport } from '../../services/pentacleAssets';

// Only JSON validation and report selection are ported from the public web
// client. Mobile never fetches or evaluates the catalog's script/style files.
type JsonRecord = Record<string, any>;
export type ReportDescriptor = {
  spec_id: string; asset_id_prefix: string; key_format: string; rev_width: number;
  producer_stream_id?: string; writer_enforced: boolean; select: 'latest'; list: boolean;
  history_limit: number; title_template?: string;
};
type BoardCommon = { id: string; name: string; description?: string };
export type CatalogBoard = BoardCommon & (
  { kind: 'report'; report: ReportDescriptor } |
  { kind: 'web-adapter'; web: { script: string; sha256: string; css?: string; css_sha256?: string }; actions?: string[]; poll_interval_ms?: number } |
  { kind: 'hosted-view'; hosted: { url: string } }
);
export type Catalog = {
  schema_version: 1; catalog_version: string; package: { repo: string; commit: string };
  requires: { host_api: number }; libs?: { path: string; sha256: string }[]; boards: CatalogBoard[];
};
class CatalogValidationError extends Error { unsupported = false; }
const reason = (error: unknown): string => error instanceof Error ? error.message : String(error || 'unknown error');

export const HOST_API = 1;
const own = (o: JsonRecord, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const object = (v: unknown, p: string) => { if (!v || typeof v !== 'object' || Array.isArray(v)) fail(p, 'must be an object'); };
const fail = (p: string, m: string): never => { throw new Error(`${p}: ${m}`); };
const unknown = (v: JsonRecord, p: string, allowed: string[]) => { object(v, p); const keys = Object.keys(v).filter(k => !allowed.includes(k)); if (keys.length) fail(p, `unknown keys: ${keys.sort().join(', ')}`); };
const chars = (s: string) => Array.from(s).length;
function string(v: JsonRecord, k: string, p: string, max?: number): string { const s = v[k]; if (typeof s !== 'string' || !s.trim()) fail(p, 'must be a non-empty string'); if (max && chars(s) > max) fail(p, `must be at most ${max} characters`); return s; }
function match(v: JsonRecord, k: string, p: string, re: RegExp): string { if (typeof v[k] !== 'string' || !(v[k].match(re)?.[0] === v[k])) fail(p, `must match ${re.source}`); return v[k]; }
function integer(v: unknown, p: string, min: number, max: number) { if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(p, `must be an integer ${min}-${max}`); }
const patterns = {
  version: /^[0-9A-Za-z.+-]{1,64}$/, id: /^[a-z0-9][a-z0-9-]{1,63}$/,
  path: /^web\/[a-z0-9][a-z0-9._-]{0,80}\.(js|css)$/,
  hash: /^[0-9a-f]{64}$/, commit: /^[0-9a-f]{40}$/,
  spec: /^[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/, prefix: /^[a-z0-9][a-z0-9._-]{0,63}$/,
  stream: /^[A-Za-z0-9._-]{1,64}:[A-Za-z0-9._-]{1,128}$/,
};
export function keyFormatWidth(value: unknown): number {
  if (typeof value !== 'string' || !value) throw new Error('key_format must be a non-empty string');
  const token = /\[(0-9|A-Z)\](?:\{([0-9]{1,2})\})?|([0-9A-Z_-])|(\\\.)/y;
  let at = 0, width = 0;
  while (at < value.length) {
    token.lastIndex = at; const m = token.exec(value);
    if (!m) throw new Error(`key_format: unsupported token at offset ${at}`);
    const count = m[1] && m[2] !== undefined ? Number(m[2]) : 1;
    if (count < 1) throw new Error('key_format: class count must be >= 1');
    width += count; at = token.lastIndex;
  }
  if (width < 4 || width > 32) throw new Error(`key_format: width ${width} outside 4-32`);
  return width;
}
export function plainHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string' || chars(value) > 2048 || /\s/.test(value) || !/^https?:\/\/[^/]/i.test(value)) return false;
  try {
    const url = new URL(value); const authority = value.split('/')[2];
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password && !authority.includes('@') && !authority.includes('\\');
  } catch { return false; }
}
// Python json.dumps uses a space after separators; measure the same UTF-8
// representation rather than admitting oversized entries with compact JSON.
function serializedBytes(value: unknown): number {
  function dump(v: any): string {
    if (Array.isArray(v)) return '[' + v.map(dump).join(', ') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).map(k => JSON.stringify(k) + ': ' + dump(v[k])).join(', ') + '}';
    return JSON.stringify(v);
  }
  return Array.from(dump(value)).reduce((n, char) => { const code = char.codePointAt(0)!; return n + (code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4); }, 0);
}
function validateReport(v: JsonRecord, p: string) {
  unknown(v, p, ['spec_id', 'asset_id_prefix', 'key_format', 'rev_width', 'producer_stream_id', 'writer_enforced', 'select', 'list', 'history_limit', 'title_template']);
  const spec = match(v, 'spec_id', `${p}.spec_id`, patterns.spec);
  if (spec.split('__').length !== 2) fail(`${p}.spec_id`, 'must be a spec id <repo>__<topic>');
  match(v, 'asset_id_prefix', `${p}.asset_id_prefix`, patterns.prefix);
  try { keyFormatWidth(v.key_format); } catch (e) { fail(`${p}.key_format`, reason(e)); }
  integer(v.rev_width, `${p}.rev_width`, 0, 3);
  if (own(v, 'producer_stream_id')) match(v, 'producer_stream_id', `${p}.producer_stream_id`, patterns.stream);
  for (const k of ['writer_enforced', 'list']) if (typeof v[k] !== 'boolean') fail(`${p}.${k}`, 'must be a boolean');
  if (v.select !== 'latest') fail(`${p}.select`, "must be 'latest'");
  integer(v.history_limit, `${p}.history_limit`, 1, 100);
  if (own(v, 'title_template')) {
    const t = v.title_template;
    if (typeof t !== 'string' || chars(t) > 80) fail(`${p}.title_template`, 'must be a string of at most 80 characters');
    const bad = [...t.matchAll(/\{([^{}]*)\}/g)].some(m => !['key', 'rev'].includes(m[1]));
    if (bad || (t.match(/\{/g) || []).length !== (t.match(/\}/g) || []).length) fail(`${p}.title_template`, 'only {key} and {rev} placeholders are allowed');
  }
}
export function validateCatalog(value: unknown): Catalog {
  const v = value as JsonRecord;
  const p = 'catalog'; unknown(v, p, ['schema_version', 'catalog_version', 'package', 'requires', 'libs', 'boards']);
  if (v.schema_version !== 1) fail(`${p}.schema_version`, 'must be 1');
  match(v, 'catalog_version', `${p}.catalog_version`, patterns.version);
  unknown(v.package, `${p}.package`, ['repo', 'commit']); string(v.package, 'repo', `${p}.package.repo`, 128); match(v.package, 'commit', `${p}.package.commit`, patterns.commit);
  unknown(v.requires, `${p}.requires`, ['host_api']); integer(v.requires.host_api, `${p}.requires.host_api`, 1, Infinity);
  const libs = own(v, 'libs') ? v.libs : [];
  if (!Array.isArray(libs) || libs.length > 8) fail(`${p}.libs`, 'must be a list of at most 8 entries');
  libs.forEach((lib: JsonRecord, i: number) => { const q = `${p}.libs[${i}]`; unknown(lib, q, ['path', 'sha256']); match(lib, 'path', `${q}.path`, patterns.path); match(lib, 'sha256', `${q}.sha256`, patterns.hash); });
  if (!Array.isArray(v.boards) || v.boards.length > 64) fail(`${p}.boards`, 'must be a list of at most 64 entries');
  const ids = new Set();
  v.boards.forEach((b: JsonRecord, i: number) => {
    const q = `${p}.boards[${i}]`; object(b, q);
    if (serializedBytes(b) > 8192) fail(q, 'entry exceeds 8192 bytes serialized');
    match(b, 'id', `${q}.id`, patterns.id); if (ids.has(b.id)) fail(`${q}.id`, `duplicate board id '${b.id}'`); ids.add(b.id);
    string(b, 'name', `${q}.name`, 64);
    if (own(b, 'description') && (typeof b.description !== 'string' || chars(b.description) > 200)) fail(`${q}.description`, 'must be a string of at most 200 characters');
    const common = ['id', 'name', 'description', 'kind'];
    if (b.kind === 'report') { unknown(b, q, [...common, 'report']); validateReport(b.report, `${q}.report`); }
    else if (b.kind === 'web-adapter') {
      unknown(b, q, [...common, 'web', 'actions', 'poll_interval_ms']); unknown(b.web, `${q}.web`, ['script', 'sha256', 'css', 'css_sha256']);
      match(b.web, 'script', `${q}.web.script`, patterns.path); if (!b.web.script.endsWith('.js')) fail(`${q}.web.script`, 'must be a .js path'); match(b.web, 'sha256', `${q}.web.sha256`, patterns.hash);
      if (own(b.web, 'css') || own(b.web, 'css_sha256')) { match(b.web, 'css', `${q}.web.css`, patterns.path); if (!b.web.css.endsWith('.css')) fail(`${q}.web.css`, 'must be a .css path'); match(b.web, 'css_sha256', `${q}.web.css_sha256`, patterns.hash); }
      if (own(b, 'actions')) {
        if (!Array.isArray(b.actions) || b.actions.some((a: unknown) => typeof a !== 'string')) fail(`${q}.actions`, 'must be a list of strings');
        const bad = b.actions.filter((a: string) => !['household', 'assistantState', 'assetList', 'assetGet'].includes(a)); if (bad.length) fail(`${q}.actions`, `unknown host actions: ${bad.join(', ')}`);
      }
      if (own(b, 'poll_interval_ms')) integer(b.poll_interval_ms, `${q}.poll_interval_ms`, 2000, 600000);
    } else if (b.kind === 'hosted-view') {
      unknown(b, q, [...common, 'hosted']); unknown(b.hosted, `${q}.hosted`, ['url']); string(b.hosted, 'url', `${q}.hosted.url`);
      if (!plainHttpUrl(b.hosted.url)) fail(`${q}.hosted.url`, 'must be an absolute http(s) URL with a host and no userinfo');
    } else fail(`${q}.kind`, 'must be one of: hosted-view, report, web-adapter');
  });
  if (v.requires.host_api > HOST_API) { const error = new CatalogValidationError(`requires.host_api ${v.requires.host_api} exceeds ${HOST_API}`); error.unsupported = true; throw error; }
  return v as Catalog;
}

export function reportIdGrammar(prefix: string, keyFormat: string, revWidth: number): RegExp {
  keyFormatWidth(keyFormat);
  if (!Number.isInteger(revWidth) || revWidth < 0 || revWidth > 3) throw new Error('rev_width must be an integer 0-3');
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const suffix = revWidth ? `(-r(?!0+$)[0-9]{${revWidth}})?` : '';
  return new RegExp(`^${escaped}(${keyFormat})${suffix}$(?![\\s\\S])`);
}
export function reportRequest(report: ReportDescriptor) {
  return { spec_id: report.spec_id, asset_id_prefix: report.asset_id_prefix,
    ...(report.producer_stream_id !== undefined ? { producer: report.producer_stream_id } : {}),
    sort: 'asset_id_desc' as const, limit: Math.min(4 * report.history_limit, 400) };
}
export type ReportEntry = { row: PentacleReport; key: string; rev: number };
export type ReportOutcome = {
  state: 'error' | 'empty' | 'complete' | 'partial'; latest: string | null;
  latestEntry?: ReportEntry; entries: ReportEntry[]; keys: [string, number][];
  window_full: boolean; truncated: boolean; header: string; notice: string; unexpected_id?: string;
  global_latest_when_writer_enforced?: boolean;
};
export function selectReports(report: ReportDescriptor, rows: PentacleReport[]): ReportOutcome {
  if (!Array.isArray(rows)) throw new Error('report list is missing assets');
  const window = reportRequest(report).limit, grammar = reportIdGrammar(report.asset_id_prefix, report.key_format, report.rev_width);
  const parsed: ReportEntry[] = [];
  const empty: ReportOutcome = { state: 'empty', latest: null, entries: [], keys: [], window_full: false, truncated: false, header: '', notice: '' };
  for (const row of rows) {
    const id = row?.asset_id;
    if (typeof id !== 'string' || !id.startsWith(report.asset_id_prefix)) throw new Error('report list returned an asset outside its namespace');
    const match = grammar.exec(id);
    if (!match) return { ...empty, state: 'error', unexpected_id: id, notice: `unsupported asset id ${id} in namespace ${report.asset_id_prefix}` };
    parsed.push({ row, key: match[1], rev: match[2] ? Number(match[2].slice(2)) : 0 });
  }
  if (!rows.length) return empty;
  if (rows.length > window) throw new Error('report list exceeded its requested window');
  const byKey = new Map<string, ReportEntry>();
  for (const item of parsed) if (!byKey.has(item.key) || byKey.get(item.key)!.rev < item.rev) byKey.set(item.key, item);
  const entries = [...byKey.values()].slice(0, report.history_limit), windowFull = rows.length === window;
  const truncated = windowFull && entries.length < report.history_limit;
  return { state: windowFull ? 'partial' : 'complete', latest: rows[0].asset_id, latestEntry: parsed[0],
    entries, keys: entries.map(({key, rev}) => [key, rev]), window_full: windowFull, truncated,
    global_latest_when_writer_enforced: windowFull && report.writer_enforced,
    header: windowFull && !report.writer_enforced ? 'latest in loaded window' : 'latest',
    notice: truncated ? `history truncated: ${entries.length} of up to ${report.history_limit} loaded` : '' };
}

export function getCatalogSpecId(): string | undefined {
  if (process.env.EXPO_PUBLIC_HARNESS === '1') {
    const param = harnessRuntime.getParam('dashboard_catalog_spec_id');
    if (param !== undefined) return param.trim() || undefined;
  }
  const value = Constants.expoConfig?.extra?.dashboardCatalogSpecId;
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}
export type CatalogResult = { status: 'unset' | 'ready' | 'unavailable' | 'malformed' | 'unsupported' | 'superseded'; catalog: Catalog | null; cached: boolean; age?: number; message?: string };
type CacheRecord = { catalog: Catalog; savedAt: number };
type Storage = Pick<typeof AsyncStorage, 'getItem' | 'setItem'>;
type LoaderOptions = { listReportsBySpec?: typeof listReportsBySpec; getReportByOwner?: typeof getReportByOwner; storage?: Storage | null; now?: () => number };
export function createCatalogLoader(options: LoaderOptions = {}) {
  // Keep the unconfigured tab free of transport/session-viewer initialization.
  const list: typeof listReportsBySpec = options.listReportsBySpec || ((...args) => require('../../services/pentacleAssets').listReportsBySpec(...args));
  const get: typeof getReportByOwner = options.getReportByOwner || ((...args) => require('../../services/pentacleAssets').getReportByOwner(...args));
  const storage = options.storage === undefined ? AsyncStorage : options.storage, now = options.now || Date.now;
  const memory = new Map<string, CacheRecord>(); let generation = 0, writes = Promise.resolve();
  async function cached(spec: string): Promise<CacheRecord | null> {
    if (memory.has(spec)) return memory.get(spec)!;
    try {
      const saved = await storage?.getItem(`dashboard-catalog:${spec}`);
      if (memory.has(spec)) return memory.get(spec)!;
      const record = JSON.parse(saved || 'null');
      if (record && Number.isFinite(record.savedAt)) { validateCatalog(record.catalog); memory.set(spec, record); return record; }
    } catch { /* Invalid or inaccessible persisted data is not a usable cache. */ }
    return null;
  }
  async function refresh(spec?: string): Promise<CatalogResult> {
    const token = ++generation;
    if (!spec) return { status: 'unset', catalog: null, cached: false };
    let body: unknown;
    try {
      const rows = await list(spec);
      if (!Array.isArray(rows)) throw new Error('asset.list returned no assets');
      const record = rows.find(r => r?.content_type === 'dashboard-catalog' && r.asset_id === 'dashboard-catalog');
      if (!record || typeof record.stream_id !== 'string' || !record.stream_id) throw new Error('dashboard-catalog asset not found');
      const asset = await get(record.stream_id, record.asset_id, spec);
      if (!asset || !Object.prototype.hasOwnProperty.call(asset, 'body')) throw new Error('asset.get returned no catalog body');
      body = asset.body;
    } catch (error) {
      const record = await cached(spec);
      if (token !== generation) return { status: 'superseded', catalog: null, cached: false };
      return { status: 'unavailable', message: `Dashboard catalog unavailable: ${reason(error)}`, catalog: record?.catalog || null,
        cached: !!record, ...(record ? { age: Math.max(0, now() - record.savedAt) } : {}) };
    }
    if (token !== generation) return { status: 'superseded', catalog: null, cached: false };
    let parsed: unknown, catalog: Catalog;
    try { parsed = typeof body === 'string' ? JSON.parse(body) : body; catalog = validateCatalog(parsed); }
    catch (error) {
      const version = parsed && typeof parsed === 'object' && 'catalog_version' in parsed && typeof parsed.catalog_version === 'string' ? parsed.catalog_version : 'unknown';
      return { status: error instanceof CatalogValidationError && error.unsupported ? 'unsupported' : 'malformed', catalog: null, cached: false,
        message: `Dashboard catalog unsupported/malformed: ${reason(error)} (catalog ${version})` };
    }
    const record = { catalog, savedAt: now() }; memory.set(spec, record);
    // Serialize persistence so an older slow write cannot overwrite a newer valid fetch.
    writes = writes.catch(() => {}).then(async () => { try { await storage?.setItem(`dashboard-catalog:${spec}`, JSON.stringify(record)); } catch {} });
    return { status: 'ready', catalog, cached: false };
  }
  return { refresh, cancel: () => { generation++; }, flush: () => writes };
}
