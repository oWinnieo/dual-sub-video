import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('the built-in sample clip is shipped with the app', async () => {
  const samplePath = path.join(process.cwd(), 'public', 'samples', 'sample.mp4');
  const sample = await stat(samplePath);

  assert.equal(sample.isFile(), true);
  assert.ok(sample.size > 0, 'public/samples/sample.mp4 must not be empty');
});
