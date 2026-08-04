import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTranslationEnvelope,
  clampTranslationBatchSize,
  parseTranslationEnvelope,
  splitTranslationItems,
} from '../src/lib/translation-batch.js';

test('caps requested translation batches at forty items', () => {
  assert.equal(clampTranslationBatchSize(0), 20);
  assert.equal(clampTranslationBatchSize(25), 25);
  assert.equal(clampTranslationBatchSize(200), 40);
});

test('splits by item count and character budget without changing order', () => {
  const items = [
    { id: 'a', text: 'a'.repeat(150) },
    { id: 'b', text: 'b'.repeat(150) },
    { id: 'c', text: 'c'.repeat(150) },
  ];
  const batches = splitTranslationItems(items, 40, 250);
  assert.deepEqual(batches.map((batch) => batch.length), [1, 1, 1]);
  assert.deepEqual(batches.flat().map((item) => item.id), ['a', 'b', 'c']);
});

test('round-trips an aligned marked translation envelope', () => {
  const items = [{ text: 'Hello' }, { text: 'World' }];
  const envelope = buildTranslationEnvelope(items, 'abc123');
  assert.match(envelope, /⟦LLB_abc123_0000⟧/);
  assert.deepEqual(
    parseTranslationEnvelope('⟦LLB_abc123_0000⟧\n你好\n⟦LLB_abc123_0001⟧\n世界', 2, 'abc123'),
    ['你好', '世界'],
  );
});

test('rejects missing or duplicate alignment markers', () => {
  assert.throws(
    () => parseTranslationEnvelope('⟦LLB_token_0000⟧\nOnly one', 2, 'token'),
    /expected 2 markers/,
  );
  assert.throws(
    () => parseTranslationEnvelope('⟦LLB_token_0000⟧\nOne\n⟦LLB_token_0000⟧\nTwo', 2, 'token'),
    /invalid or duplicated/,
  );
});
