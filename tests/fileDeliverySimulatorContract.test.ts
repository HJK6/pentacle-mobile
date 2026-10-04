import { spawnSync } from 'node:child_process';
import path from 'node:path';
test('simulator source gate validates exact receipts, artifact identity and non-skipped evidence',()=>{
 const result=spawnSync('python3',['-m','unittest','discover','-s','test/e2e/file_delivery','-p','test_*.py'],{cwd:path.resolve(__dirname,'..'),encoding:'utf8',timeout:10000});
 expect(result.error).toBeUndefined();expect(result.status).toBe(0);expect(result.stderr).toMatch(/Ran 5 tests/);
});
