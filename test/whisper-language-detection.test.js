import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLanguageTokenProbeConfig,
  languageTokenCandidatesFromBeams,
  summarizeLanguageTokenSamples,
} from '../src/lib/whisper-language-detection.js';

test('language probe leaves the language token to Whisper and does not enable timestamps', () => {
  const config = buildLanguageTokenProbeConfig({ task_to_id: { transcribe: 50359 } });
  assert.deepEqual(config.forced_decoder_ids, [[2, 50359]]);
  assert.equal(config.max_new_tokens, 1);
  assert.equal('return_timestamps' in config, false);
});
test('extracts language probabilities from the first generated token', () => {
  const candidates = languageTokenCandidatesFromBeams([
    { output_token_ids: [50258, 50266], score: Math.log(0.98) },
    { output_token_ids: [50258, 50259], score: Math.log(0.01) },
    { output_token_ids: [50258, 50362], score: Math.log(0.005) },
  ], {
    '<|ja|>': 50266,
    '<|en|>': 50259,
  });

  assert.equal(candidates[0].language, 'ja');
  assert.ok(candidates[0].probability > 0.97);
  assert.equal(candidates.some((candidate) => candidate.language === 'nocaptions'), false);
});

test('aggregates independent language-token votes instead of decoded English text', () => {
  const result = summarizeLanguageTokenSamples([
    { candidates: [{ language: 'ja', probability: 0.98 }, { language: 'en', probability: 0.01 }] },
    { candidates: [{ language: 'ja', probability: 0.94 }, { language: 'en', probability: 0.03 }] },
    { candidates: [{ language: 'ja', probability: 0.91 }, { language: 'zh', probability: 0.04 }] },
  ]);

  assert.equal(result.language, 'ja');
  assert.ok(result.confidence > 0.9);
  assert.equal(result.evidence.method, 'whisper-language-token');
});

test('returns unknown for weak language evidence instead of locking the wrong language', () => {
  const result = summarizeLanguageTokenSamples([
    { candidates: [{ language: 'en', probability: 0.03 }] },
    { candidates: [] },
    { candidates: [{ language: 'ja', probability: 0.02 }] },
  ]);

  assert.equal(result.language, null);
  assert.ok(result.confidence < 0.35);
});
