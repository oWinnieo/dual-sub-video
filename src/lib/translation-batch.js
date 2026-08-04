const DEFAULT_BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 40;
const DEFAULT_CHARACTER_BUDGET = 6000;

function cueText(cue) {
  return String(cue?.original ?? cue?.text ?? '');
}

export function clampTranslationBatchSize(value, fallback = DEFAULT_BATCH_SIZE) {
  const numeric = Math.floor(Number(value) || fallback);
  return Math.max(1, Math.min(MAX_BATCH_SIZE, numeric));
}

export function splitTranslationItems(
  items,
  batchSize = DEFAULT_BATCH_SIZE,
  characterBudget = DEFAULT_CHARACTER_BUDGET,
) {
  const list = Array.isArray(items) ? items : [];
  const maxItems = clampTranslationBatchSize(batchSize);
  const maxCharacters = Math.max(250, Number(characterBudget) || DEFAULT_CHARACTER_BUDGET);
  const batches = [];
  let batch = [];
  let characters = 0;

  for (const item of list) {
    const textLength = cueText(item).length;
    if (batch.length && (batch.length >= maxItems || characters + textLength > maxCharacters)) {
      batches.push(batch);
      batch = [];
      characters = 0;
    }
    batch.push(item);
    characters += textLength;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function marker(token, index) {
  return `⟦LLB_${token}_${String(index).padStart(4, '0')}⟧`;
}

export function buildTranslationEnvelope(items, token) {
  if (!token || !/^[a-z0-9]+$/i.test(token)) {
    throw new Error('A safe alphanumeric batch token is required.');
  }
  return items
    .map((item, index) => `${marker(token, index)}\n${cueText(item)}`)
    .join('\n');
}

export function parseTranslationEnvelope(translatedText, expectedCount, token) {
  const count = Math.max(0, Number(expectedCount) || 0);
  if (!count) return [];
  const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`⟦\\s*LLB[_\\s-]*${escapedToken}[_\\s-]*(\\d{4})\\s*⟧`, 'giu');
  const matches = [...String(translatedText || '').matchAll(pattern)];
  if (matches.length !== count) {
    throw new Error(`Batch alignment failed: expected ${count} markers, received ${matches.length}.`);
  }

  const values = new Array(count);
  for (let matchIndex = 0; matchIndex < matches.length; matchIndex += 1) {
    const match = matches[matchIndex];
    const index = Number(match[1]);
    if (!Number.isInteger(index) || index < 0 || index >= count || values[index] !== undefined) {
      throw new Error('Batch alignment failed: marker indexes were invalid or duplicated.');
    }
    const start = match.index + match[0].length;
    const end = matches[matchIndex + 1]?.index ?? String(translatedText || '').length;
    const value = String(translatedText || '').slice(start, end).trim();
    if (!value) throw new Error(`Batch alignment failed: translation ${index} was empty.`);
    values[index] = value;
  }
  if (values.some((value) => value === undefined)) {
    throw new Error('Batch alignment failed: one or more translations were missing.');
  }
  return values;
}

export const TRANSLATION_BATCH_DEFAULTS = {
  batchSize: DEFAULT_BATCH_SIZE,
  maxBatchSize: MAX_BATCH_SIZE,
  characterBudget: DEFAULT_CHARACTER_BUDGET,
};
