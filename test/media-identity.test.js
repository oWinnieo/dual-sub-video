import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mediaIdentityKeys,
  partitionDuplicateMediaFiles,
} from '../src/lib/media-identity.js';

function fakeFile(name, size, lastModified) {
  return { name, size, lastModified, type: 'video/mp4' };
}

test('recognizes the same desktop path regardless of file metadata', () => {
  const existingFile = fakeFile('ryuichi2.mp4', 10, 100);
  const selectedAgain = fakeFile('renamed-in-picker.mp4', 20, 200);
  const result = partitionDuplicateMediaFiles(
    [selectedAgain],
    [{ file: existingFile, path: '/Users/ryuuna/Desktop/ryuichi2.mp4' }],
    () => '/Users/ryuuna/Desktop/ryuichi2.mp4',
  );

  assert.equal(result.unique.length, 0);
  assert.deepEqual(result.duplicates, [selectedAgain]);
});

test('recognizes the same browser file from stable metadata', () => {
  const existingFile = fakeFile('ryuichi2.mp4', 11_000_000, 123456789);
  const selectedAgain = fakeFile('ryuichi2.mp4', 11_000_000, 123456789);
  const result = partitionDuplicateMediaFiles(
    [selectedAgain],
    [{ file: existingFile, path: '' }],
    () => '',
  );

  assert.equal(result.unique.length, 0);
  assert.equal(result.duplicates.length, 1);
});

test('keeps new files while removing duplicates within one selection', () => {
  const first = fakeFile('first.mp4', 100, 1000);
  const firstAgain = fakeFile('first.mp4', 100, 1000);
  const second = fakeFile('second.mp4', 200, 2000);
  const result = partitionDuplicateMediaFiles([first, firstAgain, second], [], () => '');

  assert.deepEqual(result.unique.map(({ file }) => file), [first, second]);
  assert.deepEqual(result.duplicates, [firstAgain]);
  assert.deepEqual(result.unique[0].identityKeys, mediaIdentityKeys(first));
});
