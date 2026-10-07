import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// P6 exclusions (spec § Validation): the overlay's voice mode adds no second audio path and no
// live transcription. Recording, upload and transcription stay the existing voice unit.
test('src/components/questions has no second audio path and no streaming transcription', () => {
  const root = path.resolve(__dirname, '../..');
  const files = execFileSync('git', ['ls-files', '--others', '--cached', '--exclude-standard', 'src/components/questions', 'app/pentacle/questions.tsx'], { cwd: root })
    .toString().split('\n').filter(Boolean).filter((file) => /\.(ts|tsx)$/.test(file));
  expect(files.length).toBeGreaterThan(0);
  const offenders = files.filter((file) => {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    return /expo-av|expo-audio|uploadBlobBase64|transcribeBlob|runVoiceUploadTranscribe|stream_transcri|live_transcri|partial_transcript/i.test(source);
  });
  expect(offenders).toEqual([]);
});

test('the overlay reaches recording only through the app voice recorder singleton', () => {
  const root = path.resolve(__dirname, '../..');
  const source = fs.readFileSync(path.join(root, 'src/components/questions/voice/useVoiceAnswers.ts'), 'utf8');
  expect(source).toMatch(/voiceRecordingEngine/);
});
