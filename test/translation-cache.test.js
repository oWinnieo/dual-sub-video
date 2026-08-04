import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  clearPersistentTranslationCache,
  readPersistentTranslation,
  readSessionTranslation,
  translationCacheStats,
  verifyTranslationCacheDirectory,
  writePersistentTranslation,
  writeSessionTranslation,
} from '../src/lib/translation-cache.js';

const descriptor = {
  provider: 'google-free',
  model: 'none',
  from: 'en',
  to: 'zh',
  text: 'Hello',
};

test('writes, reads, reports, and clears a user-selected cache directory', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lingoloop-translation-cache-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  assert.equal(await verifyTranslationCacheDirectory(directory), directory);
  assert.equal(await readPersistentTranslation(directory, descriptor), null);
  await writePersistentTranslation(directory, descriptor, '你好');
  assert.equal(await readPersistentTranslation(directory, descriptor), '你好');
  writeSessionTranslation(directory, descriptor, '会话缓存');
  assert.equal(readSessionTranslation(directory, descriptor), '会话缓存');

  const populated = await translationCacheStats(directory);
  assert.equal(populated.entries, 1);
  assert.ok(populated.bytes > 0);

  const cleared = await clearPersistentTranslationCache(directory);
  assert.equal(cleared.entries, 0);
  assert.equal((await translationCacheStats(directory)).entries, 0);
  assert.equal(readSessionTranslation(directory, descriptor), null);
});
