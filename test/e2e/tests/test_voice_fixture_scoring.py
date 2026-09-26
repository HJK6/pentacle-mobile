from pathlib import Path
import importlib.util
import json
import pytest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('voice_fixtures', ROOT / 'test/fixtures/voice/fixtures.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
FIXTURES = json.loads((ROOT / 'test/fixtures/voice/utterances.json').read_text())

def modes():
    return {mode: {fixture['id']: {'text': fixture['text'], 'latency_s': 1} for fixture in FIXTURES} for mode in ('baseline', 'fleet', 'ios')}

def test_exact_transcripts_pass_all_metric_bounds():
    result = module.score(FIXTURES, modes())
    assert result['metrics_pass']
    assert result['fleet']['wer'] == 0
    assert result['fleet']['name_recall'] == {'Juniper': 1, 'Atlas': 1, 'Rowan': 1}

def test_decoy_name_invention_rejects_even_when_name_recall_is_perfect():
    data = modes()
    data['fleet']['decoy-01']['text'] = 'It is Juniper and settlement.'
    result = module.score(FIXTURES, data)
    assert not result['metrics_pass']
    assert result['fleet']['decoy_false_positives'] == 1

def test_ordinary_word_errors_reject_despite_perfect_names_and_no_decoy_errors():
    data = modes()
    data['fleet']['juniper-1']['text'] = 'Juniper'
    result = module.score(FIXTURES, data)
    assert not result['metrics_pass']
    assert result['fleet']['decoy_false_positives'] == 0
    assert result['fleet']['wer'] > result['ios']['wer']

def test_missing_cells_cannot_pass_on_an_easy_subset():
    data = modes()
    del data['fleet']['mixed-60s']
    with pytest.raises(ValueError, match='missing/extra'):
        module.score(FIXTURES, data)


@pytest.mark.parametrize('removed', ['decoy-10', 'juniper-3', 'mixed-60s'])
def test_shrunken_corpus_cannot_reduce_acceptance_denominators(removed):
    subset = [fixture for fixture in FIXTURES if fixture['id'] != removed]
    data = {mode: {fixture['id']: {'text': fixture['text'], 'latency_s': 1} for fixture in subset} for mode in ('baseline', 'fleet', 'ios')}
    with pytest.raises(ValueError, match='corpus'):
        module.score(subset, data)
