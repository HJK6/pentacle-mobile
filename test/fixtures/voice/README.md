# Voice recognition fixtures

`utterances.json` is the frozen text set: four short placements per required name,
ten decoys and one mixed passage. Generate a first-pass 16 kHz mono WAV set with
`python3 test/fixtures/voice/fixtures.py generate --output <artifact-directory>`.
This uses macOS file-only speech synthesis; it does not play audio or use the mic.
Raw audio and SHA256/duration receipts stay in the artifact directory.

The acceptance set must use the operator's recordings of these texts, including
at least 60 seconds for the mixed passage. Capture the iOS dictation baseline
from the same audio. Submit JSON maps keyed by fixture ID with `text` and
`latency_s` to the scorer:

```
python3 test/fixtures/voice/fixtures.py score --baseline baseline.json --fleet fleet.json --ios ios.json --output results.json
```

The scorer reports `metrics_pass` (metric bounds only, not operator-voice acceptance), per-name exact spelling recall, introduced fleet names on the
decoy set and overall word error rate with the same normalization in all modes.
TTS results are a rehearsal, never operator-voice acceptance. A passing report
requires every fixture in every mode, each required name at least 95%, zero
decoy false positives and fleet WER no worse than iOS. The raw mode transcripts
also carry upload/transcription latency; retain them beside the score receipt.

Every mode must contain every fixture. The ≥95% exact name recall and zero decoy false positives apply to fleet mode; fleet WER must be no worse than the iOS baseline. Baseline and iOS name/decoy metrics are diagnostic. `metrics_pass` is a scoring result, not operator-voice acceptance.
