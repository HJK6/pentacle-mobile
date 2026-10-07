import { execFileSync } from 'child_process';
import * as path from 'path';

// Exclusion (P6 rule): the Questions overlay has no voice/mic surface in P4.
test('src/components/questions and the route import nothing voice-related', () => {
  const root = path.resolve(__dirname, '../..');
  const files = execFileSync('git', ['ls-files', '--others', '--cached', '--exclude-standard', 'src/components/questions', 'app/pentacle/questions.tsx'], { cwd: root })
    .toString().split('\n').filter(Boolean);
  expect(files.length).toBeGreaterThan(0);
  const offenders = files.filter((file) => {
    const source = require('fs').readFileSync(path.join(root, file), 'utf8') as string;
    return /from\s+['"][^'"]*voice[^'"]*['"]/i.test(source) || /expo-av|expo-audio|Mic(rophone)?Glyph/.test(source);
  });
  expect(offenders).toEqual([]);
});
