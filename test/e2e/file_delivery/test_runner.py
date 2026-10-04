import importlib.util
from datetime import datetime, timezone, timedelta
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('file_gate',Path(__file__).with_name('run.py'))
gate=importlib.util.module_from_spec(spec);spec.loader.exec_module(gate)
NOW=datetime(2026,1,1,tzinfo=timezone.utc)

def receipt():
    return dict(schema=1,source_commit='a'*40,daemon_commit='b'*40,artifact_sha256='c'*64,
        app_id='com.example.fixture.harness',simulator_udid='12345678-1234-1234-1234-123456789abc',
        prepared_at=NOW.isoformat(),synthetic_only=True,disposable=True,loopback_daemon=True,
        present_sha256=gate.PRESENT_SHA,present_bytes=len(gate.BODY))

class Contract(unittest.TestCase):
    def test_source_is_not_runtime_evidence(self):
        self.assertEqual(gate.check_source()['runtime'],'not_run')
    def test_receipt(self):
        self.assertEqual(gate.validate_receipt(receipt(),NOW),receipt())
    def test_missing_extra_and_unsafe_fields(self):
        for key,value in [('source_commit','main'),('artifact_sha256','unknown'),('app_id','com.example.production'),
            ('simulator_udid','-'*36),('synthetic_only',False),('disposable',False),('loopback_daemon',False),
            ('present_sha256','d'*64),('prepared_at',(NOW-timedelta(hours=2)).isoformat()),('prepared_at',1)]:
            with self.subTest(key=key,value=value),self.assertRaises(ValueError):
                gate.validate_receipt(dict(receipt(),**{key:value}),NOW)
        with self.assertRaises(ValueError):gate.validate_receipt(dict(receipt(),token='not-allowed'),NOW)
    def test_tree_hash_detects_changes_and_escape(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'app';root.mkdir();file=root/'binary';file.write_bytes(b'fixture')
            first=gate.tree_hash(root);file.write_bytes(b'changed');self.assertNotEqual(first,gate.tree_hash(root))
            (root/'escape').symlink_to(Path(temp)/'outside')
            with self.assertRaises(ValueError):gate.tree_hash(root)
    def test_reports_refuse_empty_failed_and_skipped(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp)/'report.xml'
            for xml in ['<testsuite tests="0"/>','<testsuite failures="1"><testcase/></testsuite>',
                        '<testsuite><testcase><skipped/></testcase></testsuite>']:
                p.write_text(xml)
                with self.assertRaises(ValueError):gate.report_passed(p)
            p.write_text('<testsuite tests="1" failures="0"><testcase name="file"/></testsuite>')
            self.assertEqual(gate.report_passed(p),1)

if __name__=='__main__':unittest.main()
