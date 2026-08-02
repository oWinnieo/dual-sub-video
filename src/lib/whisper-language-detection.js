const LANGUAGE_TOKEN_PATTERN = /^<\|([a-z]{2,3})\|>$/;
const MIN_LANGUAGE_CONFIDENCE = 0.35;

export function buildLanguageTokenProbeConfig(generationConfig = {}) {
  const transcribeTokenId = Number(generationConfig?.task_to_id?.transcribe);
  if (!Number.isInteger(transcribeTokenId)) {
    throw new Error('The Whisper model does not expose a transcribe task token.');
  }

  // Do not enable return_timestamps here. Transformers.js 2.x calculates the
  // initial timestamp position from the *number* of forced decoder tokens. In
  // auto-language mode the language token is intentionally unforced, so the
  // timestamp processor can otherwise overwrite the transcribe token at
  // decoder position 2. Probe only the first model-selected token instead.
  return {
    max_new_tokens: 1,
    forced_decoder_ids: [[2, transcribeTokenId]],
    num_beams: 8,
    num_return_sequences: 8,
  };
}
export function languageTokenCandidatesFromBeams(beams, langToId = {}) {
  const languageByTokenId = new Map();
  for (const [token, tokenId] of Object.entries(langToId || {})) {
    const match = token.match(LANGUAGE_TOKEN_PATTERN);
    if (match && Number.isInteger(Number(tokenId))) {
      languageByTokenId.set(Number(tokenId), match[1]);
    }
  }

  const candidates = [];
  const seenLanguages = new Set();
  for (const beam of Array.isArray(beams) ? beams : []) {
    const tokens = Array.from(beam?.output_token_ids || []);
    const language = languageByTokenId.get(Number(tokens.at(-1)));
    if (!language || seenLanguages.has(language)) continue;
    const logProbability = Number(beam?.score);
    const probability = Number.isFinite(logProbability)
      ? Math.max(0, Math.min(1, Math.exp(logProbability)))
      : 0;
    candidates.push({ language, probability });
    seenLanguages.add(language);
  }

  return candidates.sort((left, right) => right.probability - left.probability);
}

export function summarizeLanguageTokenSamples(samples, minimumConfidence = MIN_LANGUAGE_CONFIDENCE) {
  const usableSamples = (Array.isArray(samples) ? samples : [])
    .filter((sample) => Array.isArray(sample?.candidates) && sample.candidates.length > 0);
  if (!usableSamples.length) {
    return {
      language: null,
      confidence: 0,
      evidence: { method: 'whisper-language-token', usableSamples: 0, totalSamples: samples?.length || 0, candidates: [] },
    };
  }

  const totals = new Map();
  let totalLanguageMass = 0;
  for (const sample of usableSamples) {
    for (const candidate of sample.candidates) {
      const probability = Number(candidate?.probability) || 0;
      if (!candidate?.language || probability <= 0) continue;
      totals.set(candidate.language, (totals.get(candidate.language) || 0) + probability);
      totalLanguageMass += probability;
    }
  }

  const candidates = [...totals.entries()]
    .map(([language, score]) => ({ language, score }))
    .sort((left, right) => right.score - left.score);
  const winner = candidates[0] || null;
  const consensus = winner && totalLanguageMass > 0 ? winner.score / totalLanguageMass : 0;
  const coverage = Math.min(1, totalLanguageMass / Math.max(1, samples?.length || usableSamples.length));
  const confidence = Number((consensus * coverage).toFixed(6));

  return {
    language: winner && confidence >= minimumConfidence ? winner.language : null,
    confidence,
    evidence: {
      method: 'whisper-language-token',
      usableSamples: usableSamples.length,
      totalSamples: samples?.length || usableSamples.length,
      languageMass: Number(totalLanguageMass.toFixed(6)),
      consensus: Number(consensus.toFixed(6)),
      coverage: Number(coverage.toFixed(6)),
      candidates: candidates.map(({ language, score }) => ({
        language,
        score: Number(score.toFixed(6)),
      })),
    },
  };
}
