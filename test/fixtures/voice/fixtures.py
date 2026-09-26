"""File-only TTS fixture generation and invariant scoring for C5."""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import subprocess
import wave
from pathlib import Path

ROOT = Path(__file__).parent
NAMES = ['Juniper', 'Atlas', 'Rowan']
FLEET = NAMES + ['Robin', 'Sorrel', 'Pentacle', 'Lattice', 'Orchid', 'Clover', 'Beacon', 'Vega', 'Cinder', 'Rune', 'Cobalt', 'Bard']

def words(text):
    return re.findall(r"[a-z]+(?:'[a-z]+)?", text.casefold())

def distance(a, b):
    row = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        next_row = [i]
        for j, y in enumerate(b, 1):
            next_row.append(min(next_row[-1] + 1, row[j] + 1, row[j - 1] + (x != y)))
        row = next_row
    return row[-1]

def validate_corpus(fixtures):
    required = {f'{name.casefold()}-{index}' for name in NAMES for index in range(1, 5)}
    required |= {f'decoy-{index:02d}' for index in range(1, 11)} | {'mixed-60s'}
    rows = {fixture['id']: fixture for fixture in fixtures}
    if len(rows) != len(fixtures) or not required.issubset(rows):
        raise ValueError('corpus: missing required name, decoy, or mixed fixtures; IDs must be unique')
    for name in NAMES:
        token = name.casefold()
        for index in range(1, 5):
            row = rows[f'{token}-{index}']
            reference = words(row['text'])
            if row['kind'] != 'name' or token not in reference:
                raise ValueError('corpus: required name case is invalid')
            position = reference.index(token)
            if (index == 1 and position != 0) or (index == 3 and position != len(reference) - 1) or (index in (2, 4) and not 0 < position < len(reference) - 1):
                raise ValueError('corpus: required initial, medial, and final name placements are invalid')
    if any(rows[f'decoy-{index:02d}']['kind'] != 'decoy' for index in range(1, 11)):
        raise ValueError('corpus: at least ten required decoy cases must be retained')
    mixed = rows['mixed-60s']
    reference = words(mixed['text'])
    if mixed['kind'] != 'mixed' or len(reference) < 100 or not all(name.casefold() in reference for name in NAMES):
        raise ValueError('corpus: required mixed passage is invalid')

def score(fixtures, modes):
    validate_corpus(fixtures)
    expected = {f['id'] for f in fixtures}
    for mode, data in modes.items():
        if set(data) != expected:
            raise ValueError(f'{mode}: missing/extra fixture IDs')
        if any(not isinstance(item.get('text'), str) or not isinstance(item.get('latency_s'), (int, float)) or item['latency_s'] < 0 for item in data.values()):
            raise ValueError(f'{mode}: each fixture needs text and nonnegative latency_s')
    result = {}
    for mode, data in modes.items():
        total = errors = decoy_false_positives = 0
        expected_names = {n: 0 for n in NAMES}
        actual_names = {n: 0 for n in NAMES}
        decoy_details = []
        for fixture in fixtures:
            reference, actual = words(fixture['text']), words(data[fixture['id']]['text'])
            total += len(reference)
            errors += distance(reference, actual)
            for name in NAMES:
                count = reference.count(name.casefold())
                expected_names[name] += count
                actual_names[name] += min(count, actual.count(name.casefold()))
            if fixture['kind'] == 'decoy':
                introduced = [n for n in FLEET if actual.count(n.casefold()) > reference.count(n.casefold())]
                decoy_false_positives += bool(introduced)
                if introduced:
                    decoy_details.append({'id': fixture['id'], 'introduced': introduced})
        result[mode] = {'name_recall': {n: actual_names[n] / expected_names[n] for n in NAMES}, 'wer': errors / total, 'decoy_false_positives': decoy_false_positives, 'decoy_details': decoy_details}
    fleet = result['fleet']
    result['metrics_pass'] = all(v >= .95 for v in fleet['name_recall'].values()) and fleet['decoy_false_positives'] == 0 and fleet['wer'] <= result['ios']['wer']
    return result

def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='command', required=True)
    generate = commands.add_parser('generate')
    generate.add_argument('--output', required=True, type=Path)
    generate.add_argument('--voice', default='Samantha')
    scoring = commands.add_parser('score')
    for mode in ('baseline', 'fleet', 'ios'):
        scoring.add_argument(f'--{mode}', required=True, type=Path)
    scoring.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    fixtures = json.loads((ROOT / 'utterances.json').read_text())
    validate_corpus(fixtures)
    if args.command == 'score':
        result = score(fixtures, {mode: json.loads(getattr(args, mode).read_text()) for mode in ('baseline', 'fleet', 'ios')})
        args.output.write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result, indent=2))
        return 0 if result['metrics_pass'] else 1
    args.output.mkdir(parents=True, exist_ok=True)
    receipt = {'kind': 'tts_rehearsal_only', 'voice': args.voice, 'source_sha256': hashlib.sha256((ROOT / 'utterances.json').read_bytes()).hexdigest(), 'audio': []}
    for fixture in fixtures:
        target = args.output / (fixture['id'] + '.wav')
        subprocess.run(['/usr/bin/say', '-v', args.voice, '-r', '160', '--file-format=WAVE', '--data-format=LEI16@16000', '-o', str(target), fixture['text']], check=True)
        with wave.open(str(target)) as wav:
            duration = wav.getnframes() / wav.getframerate()
            if wav.getnchannels() != 1 or wav.getframerate() != 16000:
                raise ValueError('unexpected capture format')
        receipt['audio'].append({'id': fixture['id'], 'path': str(target), 'duration_s': duration, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()})
    (args.output / 'manifest.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(f'Generated {len(fixtures)} rehearsal WAV files and manifest at {args.output}')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
