import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../..');
// Pure setup/redaction checks only. This test never calls the dashboard scenario,
// reads a credential, starts a daemon, or invokes a native tool.
test('native catalog setup fails closed on missing provenance and redacts split synthetic credentials', () => {
  const result = execFileSync('python3', ['-c', String.raw`
import importlib.util, io, json, sys
from pathlib import Path
sys.path[:0]=['test', 'test/e2e']
spec=importlib.util.spec_from_file_location('example_catalog_runner', 'test/e2e/run_scenario.py')
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
config={'PENTACLE_DAEMON_WS_URL':'ws://127.0.0.1:7791','dashboard_catalog_spec_id':'example__dashboard_catalog','daemon_token_file':'/tmp/example-token','daemon_token_owner_stream_id':'local:example-mobile'}
assert m.dashboard_catalog_inputs(config)['dashboard_catalog_spec_id']=='example__dashboard_catalog'
for key,value in [('PENTACLE_DAEMON_WS_URL','wss://example.test:7791'),('PENTACLE_DAEMON_WS_URL','ws://127.0.0.1:7791/?token=x'),('PENTACLE_DAEMON_WS_URL','ws://user@127.0.0.1:7791'),('PENTACLE_DAEMON_WS_URL','ws://127.0.0.1:99999'),('dashboard_catalog_spec_id','other__catalog'),('daemon_token_file','relative'),('daemon_token_owner_stream_id',''),('daemon_token_owner_stream_id','hostx:example-producer'),('daemon_token_owner_stream_id','bad/owner'),('_dashboard_catalog_phase','unset')]:
 try: m.dashboard_catalog_inputs({**config,key:value})
 except ValueError: pass
 else: raise AssertionError('invalid input was accepted: '+key)
assert m.DashboardCatalogScenario.params({**config,'_dashboard_catalog_phase':'unset'})['dashboard_catalog_spec_id']==''
assert set(m.REPORT_MODULES)=={'report_viewer_horizontal_scroll','report_viewer_runtime_sentinel','report_viewer_comments_keyboard'}
class Sink(io.StringIO):
 def close(self): pass
secret='example-synthetic-token/+=?&'
mask=m._SecretMask(secret); checks=0
for encoded in mask.forms:
 for boundary in range(len(encoded)+1):
  out=Sink(); writer=m._SecretSafeWriter(out,mask)
  writer.write('prefix '+encoded[:boundary]); writer.write(encoded[boundary:]+' suffix'); writer.close()
  assert all(value not in out.getvalue() for value in mask.forms)
  checks+=1
from types import SimpleNamespace
from e2e.harness.log_capture import LogStream
special='example-"quote\\path/😀?&'
special_mask=m._SecretMask(special)
event={'subsystem':'harness','message':'harness:ui_trace','data':{'kind':'example_trace','opaque':special}}
native=json.dumps({'processID':123,'eventMessage':'[TELEMETRY] '+json.dumps(event)})+'\n'
for boundary in range(len(native)+1):
 out=Sink(); writer=m._SecretSafeWriter(out,special_mask)
 writer.write(native[:boundary]); writer.write(native[boundary:]); writer.close()
 envelope=json.loads(out.getvalue()); decoded=json.loads(envelope['eventMessage'].split('[TELEMETRY] ',1)[1])
 assert decoded['data']['opaque']=='[REDACTED]'
stream=LogStream('example',Path('/tmp/example-unused-log'),bundle_id='com.example.mobile')
stream.feed_line(special_mask(native))
assert stream.all_events()[0].data['opaque']=='[REDACTED]'
collected=m._sanitize_command_result(SimpleNamespace(stdout='out '+special,stderr='err '+special,args=['tool',special]),special_mask)
assert special not in collected.stderr and special not in collected.stdout and collected.args[-1]=='[REDACTED]'
assert special_mask.value({'nested':[{'error':special}]})=={'nested':[{'error':'[REDACTED]'}]}
denial=m.Verdict('dashboard_catalog','FAIL',error='asset_unauthorized',extras={'daemon_error_code':'asset_unauthorized','stopped_on_denial':True,'authorization_fallback':False})
preserved=m._native_failure_result('dashboard_catalog',denial,RuntimeError('secondary '+special),None,special_mask)
assert preserved is denial and preserved.error=='asset_unauthorized' and preserved.extras['daemon_error_code']=='asset_unauthorized'
assert special not in preserved.extras['secondary_failures'][0]
m.record_cleanup_failure(preserved,'owned cleanup failed')
assert preserved.error=='asset_unauthorized' and preserved.extras['stopped_on_denial'] is True
for kind in ('dashboard_catalog_asset_get','dashboard_report_asset_get'):
 data={'scenario_run_id':'example-run','kind':kind,'status':'error','error_code':'asset_unauthorized','asset_id':'dashboard-catalog' if kind=='dashboard_catalog_asset_get' else 'example-report-20261007T1300Z','spec_id':'example__catalog','listed_stream_id':'local:example-owner','request_stream_id':'local:example-owner'}
 event=SimpleNamespace(message='harness:ui_trace',data=data,native_pid='123')
 config={'scenario_run_id':'example-run','_native_launch_pid':'123'}
 source=SimpleNamespace(all_events=lambda:[event])
 try: m.DashboardCatalogScenario()._stop_on_denial(config,source)
 except m._CatalogDaemonRefusal as error:
  assert error.code=='asset_unauthorized' and error.receipt['kind']==kind and error.receipt['asset_id']==data['asset_id']
 else: raise AssertionError('denial was not retained')
 event.native_pid='456'; m.DashboardCatalogScenario()._stop_on_denial(config,source)
print(json.dumps({'invalid_inputs':10,'split_boundary_checks':checks,'native_actions':0}))
`], { cwd: root, encoding: 'utf8', timeout: 15000 });
  expect(JSON.parse(result)).toMatchObject({ invalid_inputs: 10, native_actions: 0 });
  expect(JSON.parse(result).split_boundary_checks).toBeGreaterThan(50);
});
test('fixed report-viewer sentinel token never becomes a catalog credential', () => {
  const runner = fs.readFileSync(path.join(root, 'test/e2e/run_scenario.py'), 'utf8');
  expect(runner).toMatch(/query\["pentacle_token"\] = credential_token/);
  expect(runner).not.toMatch(/query\["pentacle_token"\] = token\b/);
});
