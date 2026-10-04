"""Source check or local iOS-simulator probe; never installs or enrolls an app.

The fleet prepares a disposable loopback daemon and harness app with exactly
fixture-present.pdf and fixture-expired.pdf in fixture:file-chat. The app's
signed build receipt binds the source revision and installed bundle digest.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[3]
BODY = b'%PDF synthetic mobile file gate'
PRESENT_SHA = hashlib.sha256(BODY).hexdigest()
FLOW = Path(__file__).with_name('simulator.yaml')


def validate_receipt(value, now=None):
    keys = {'schema','source_commit','daemon_commit','artifact_sha256','app_id','simulator_udid',
            'prepared_at','synthetic_only','disposable','loopback_daemon','present_sha256','present_bytes'}
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError('Exact fixture receipt fields required; no credentials or URLs')
    if type(value['schema']) is not int or value['schema'] != 1 or any(value[k] is not True for k in ('synthetic_only','disposable','loopback_daemon')):
        raise ValueError('Disposable synthetic loopback fixture required')
    for k in ('source_commit','daemon_commit'):
        if not isinstance(value[k],str) or not re.fullmatch('[0-9a-f]{40}',value[k]): raise ValueError('Full source commits required')
    if not re.fullmatch('[0-9a-f]{64}',str(value['artifact_sha256'])): raise ValueError('Installed artifact digest required')
    if not re.fullmatch('[A-Za-z0-9.-]+\\.harness',str(value['app_id'])): raise ValueError('Harness app identifier required')
    if not re.fullmatch('[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}',str(value['simulator_udid'])): raise ValueError('Explicit simulator UDID required')
    if not isinstance(value['prepared_at'], str): raise ValueError('Invalid receipt time')
    try: stamp = datetime.fromisoformat(value['prepared_at'].replace('Z','+00:00'))
    except (TypeError,ValueError): raise ValueError('Invalid receipt time') from None
    if stamp.utcoffset() is None: raise ValueError('Receipt time requires timezone')
    age = ((now or datetime.now(timezone.utc)) - stamp).total_seconds()
    if not 0 <= age <= 3600: raise ValueError('Fresh receipt required within one hour')
    if type(value['present_bytes']) is not int or value['present_sha256'] != PRESENT_SHA or value['present_bytes'] != len(BODY): raise ValueError('Exact synthetic fixture required')
    return value


def tree_hash(root):
    """Hash sorted relative paths, entry types and bytes; never follow symlinks."""
    root = Path(root).resolve()
    if not root.is_dir(): raise ValueError('Installed artifact directory missing')
    result = hashlib.sha256()
    count = 0
    for path in sorted(root.rglob('*')):
        rel = path.relative_to(root).as_posix()
        if path.is_symlink():
            if not path.resolve().is_relative_to(root): raise ValueError('Artifact symlink escapes bundle')
            result.update(b'L\0'+rel.encode()+b'\0'+os.readlink(path).encode()+b'\0')
            count += 1
        elif path.is_file():
            result.update(b'F\0'+rel.encode()+b'\0')
            result.update(hashlib.sha256(path.read_bytes()).digest())
            count += 1
    if not count: raise ValueError('Empty installed artifact')
    return result.hexdigest()


def report_passed(path):
    if Path(path).stat().st_size > 1024*1024: raise ValueError('Oversize test report')
    root=ET.parse(path).getroot()
    cases=list(root.iter('testcase'))
    if not cases or any(list(root.iter(tag)) for tag in ('failure','error','skipped')):
        raise ValueError('Missing, skipped or failed Maestro cases')
    for suite in root.iter('testsuite'):
        if any(int(suite.attrib.get(k,0)) != 0 for k in ('failures','errors','skipped')): raise ValueError('Failed or skipped report counters')
    return len(cases)


def check_source():
    flow=FLOW.read_text()
    for marker in ('fixture-present.pdf','fixture-expired.pdf','enabled: false','Save to Files','file-unavailable','file-native-share'):
        if marker not in flow: raise ValueError('Missing simulator oracle: '+marker)
    if any(word in flow for word in ('clearState','clearKeychain','setPermissions','http://','https://','optional:')):
        raise ValueError('Unexpected destructive, network or optional command')
    return {'status':'source_checked','runtime':'not_run','present_sha256':PRESENT_SHA,'present_bytes':len(BODY)}


def command(args):
    return subprocess.check_output(args, text=True, timeout=60).strip()


def run(receipt_path, device):
    check_source()
    if platform.system() != 'Darwin': raise ValueError('Simulator execution requires the fleet Mac')
    receipt=validate_receipt(json.loads(Path(receipt_path).read_text()))
    if device != receipt['simulator_udid']: raise ValueError('Simulator receipt mismatch')
    if command(['git','-C',str(ROOT),'rev-parse','HEAD']) != receipt['source_commit']: raise ValueError('Checkout revision mismatch')
    if command(['git','-C',str(ROOT),'status','--porcelain','--untracked-files=no']): raise ValueError('Tracked source must be clean')
    app=Path(command(['xcrun','simctl','get_app_container',device,receipt['app_id'],'app']))
    if tree_hash(app) != receipt['artifact_sha256']: raise ValueError('Installed artifact mismatch')
    data=Path(command(['xcrun','simctl','get_app_container',device,receipt['app_id'],'data']))
    cache=data/'Library'/'Caches'/'pentacle-file-delivery'
    if cache.is_symlink() or not cache.resolve().is_relative_to(data.resolve()): raise ValueError('Cache escapes app container')
    previous={str(p) for p in cache.rglob('fixture-present.pdf')} if cache.exists() else set()
    output=Path(tempfile.mkdtemp(prefix='pentacle-file-simulator-'))
    started=time.time()
    verdict={'source_commit':receipt['source_commit'],'daemon_commit':receipt['daemon_commit'],
        'artifact_sha256':receipt['artifact_sha256'],'status':'failed','physical_device_save':'not_run'}
    try:
        result=subprocess.run(['maestro','--udid',device,'test','-e','APP_ID='+receipt['app_id'],
            '--test-output-dir',str(output),'--debug-output',str(output),'--format','junit',
            '--output',str(output/'report.xml'),str(FLOW)],capture_output=True,text=True,timeout=180)
        (output/'maestro.log').write_text(result.stdout+result.stderr)
        if result.returncode: raise ValueError('Maestro failed')
        verdict['cases']=report_passed(output/'report.xml')
        current=[p for p in cache.rglob('fixture-present.pdf') if str(p) not in previous and p.stat().st_mtime >= started-1]
        if len(current)!=1 or current[0].is_symlink() or current[0].read_bytes()!=BODY:
            raise ValueError('Fresh native share file missing or digest mismatch')
        verdict['download_sha256']=hashlib.sha256(current[0].read_bytes()).hexdigest()
        for name in ('file-unavailable','file-native-share'):
            screenshots=list(output.rglob(name+'.png'))
            if len(screenshots)!=1 or screenshots[0].read_bytes()[:8]!=b'\x89PNG\r\n\x1a\n': raise ValueError('Required screenshot missing')
        verdict['status']='passed'
    except Exception as exc:
        verdict['error']=str(exc)
    finally:
        # Only the explicitly named disposable harness app. No daemon or device setup.
        try:
            cleanup=subprocess.run(['xcrun','simctl','terminate',device,receipt['app_id']],capture_output=True,timeout=30)
            if cleanup.returncode: verdict.update(status='failed',cleanup_error='Harness app termination failed')
        except Exception:
            verdict.update(status='failed',cleanup_error='Harness app termination unavailable')
        (output/'verdict.json').write_text(json.dumps(verdict,indent=2)+'\n')
    print(json.dumps({'output':str(output),'status':verdict['status']}))
    return 0 if verdict['status']=='passed' else 1


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check',action='store_true');parser.add_argument('--run',action='store_true')
    parser.add_argument('--receipt');parser.add_argument('--device')
    args=parser.parse_args()
    if args.check and not args.run: print(json.dumps(check_source()))
    elif args.run and args.receipt and args.device: raise SystemExit(run(args.receipt,args.device))
    else: parser.error('use --check or --run --receipt PRIVATE_JSON --device EXACT_UDID')
