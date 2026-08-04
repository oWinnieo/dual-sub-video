import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildProgressiveSegmentRanges,
  estimateProgressiveBuffer,
  continuousGeneratedThrough,
  generatedCoverageSeconds,
  generatedRangeAt,
  mergeGeneratedRange,
  mergeProgressiveCues,
  progressiveTranslationConcurrency,
  progressiveResumeCheckpoint,
  resumableProgressiveSegmentRanges,
  selectPrioritySegmentIndex,
  splitTranslationBatches,
} from '../src/lib/progressive-buffer.js';

test('uses short startup segments before switching to steady three-minute segments', () => {
  assert.deepEqual(
    buildProgressiveSegmentRanges(700, [60, 60, 120], 180),
    [
      { start: 0, end: 60 },
      { start: 60, end: 120 },
      { start: 120, end: 240 },
      { start: 240, end: 420 },
      { start: 420, end: 600 },
      { start: 600, end: 700 },
    ],
  );
});

test('truncates the startup plan cleanly for short media', () => {
  assert.deepEqual(
    buildProgressiveSegmentRanges(90, [60, 60, 120], 180),
    [{ start: 0, end: 60 }, { start: 60, end: 90 }],
  );
});

test('resumes from a safe checkpoint while preserving absolute segment indexes', () => {
  assert.deepEqual(
    resumableProgressiveSegmentRanges(700, 120, [60, 60, 120], 180),
    {
      totalSegments: 6,
      ranges: [
        { index: 2, start: 120, end: 240 },
        { index: 3, start: 240, end: 420 },
        { index: 4, start: 420, end: 600 },
        { index: 5, start: 600, end: 700 },
      ],
    },
  );
});

test('can resume inside an unfinished segment without replaying its completed prefix', () => {
  assert.deepEqual(
    resumableProgressiveSegmentRanges(420, 175, [60, 60, 120], 180).ranges[0],
    { index: 2, start: 175, end: 240 },
  );
});

test('resumes only after the last consecutively completed translation segment', () => {
  assert.equal(progressiveResumeCheckpoint({
    durationSeconds: 700,
    completedSegmentIndexes: [0, 1, 3],
  }), 120);
  assert.equal(progressiveResumeCheckpoint({
    durationSeconds: 700,
    completedSegmentIndexes: [1, 2],
  }), 0);
});

test('splits translation cues into small ordered batches', () => {
  const cues = Array.from({ length: 19 }, (_, index) => ({ id: index + 1 }));
  const batches = splitTranslationBatches(cues, 8);

  assert.deepEqual(batches.map((batch) => batch.length), [8, 8, 3]);
  assert.deepEqual(batches.flat().map((cue) => cue.id), cues.map((cue) => cue.id));
});

test('caps progressive translation concurrency at three workers', () => {
  assert.equal(progressiveTranslationConcurrency(1), 1);
  assert.equal(progressiveTranslationConcurrency(2), 2);
  assert.equal(progressiveTranslationConcurrency(12), 3);
});

test('uses the minimum startup buffer when generation keeps up with playback', () => {
  const estimate = estimateProgressiveBuffer({
    processedThrough: 120,
    elapsedSeconds: 80,
    durationSeconds: 3600,
  });

  assert.equal(estimate.targetBufferSeconds, 120);
  assert.equal(estimate.estimatedWaitSeconds, 0);
  assert.equal(estimate.smoothReady, true);
});

test('increases the startup buffer and wait estimate on a slow connection', () => {
  const estimate = estimateProgressiveBuffer({
    processedThrough: 120,
    elapsedSeconds: 240,
    durationSeconds: 3600,
  });

  assert.equal(estimate.generationRate, 0.5);
  assert.equal(estimate.targetBufferSeconds, 360);
  assert.equal(estimate.estimatedWaitSeconds, 480);
  assert.equal(estimate.smoothReady, false);
});

test('never recommends buffering beyond the remaining media duration', () => {
  const estimate = estimateProgressiveBuffer({
    processedThrough: 90,
    elapsedSeconds: 300,
    durationSeconds: 180,
  });

  assert.equal(estimate.targetBufferSeconds, 180);
});

test('prioritizes the segment containing the requested playback position', () => {
  const queue = [
    { segment: { start: 300, end: 480 } },
    { segment: { start: 120, end: 300 } },
    { segment: { start: 480, end: 660 } },
  ];

  assert.equal(selectPrioritySegmentIndex(queue, {
    playbackTime: 510,
  }), 2);
});

test('prioritizes future segments over work behind the requested position', () => {
  const queue = [
    { segment: { start: 120, end: 300 } },
    { segment: { start: 480, end: 660 } },
    { segment: { start: 660, end: 840 } },
  ];

  assert.equal(selectPrioritySegmentIndex(queue, {
    playbackTime: 450,
  }), 1);
});

test('merges sparse generated ranges and keeps timeline holes visible', () => {
  let ranges = mergeGeneratedRange([], { start: 0, end: 120 });
  ranges = mergeGeneratedRange(ranges, { start: 300, end: 360 });
  ranges = mergeGeneratedRange(ranges, { start: 118, end: 180 });

  assert.deepEqual(ranges, [{ start: 0, end: 180 }, { start: 300, end: 360 }]);
  assert.equal(continuousGeneratedThrough(ranges), 180);
  assert.equal(generatedCoverageSeconds(ranges), 240);
  assert.equal(generatedRangeAt(ranges, 330)?.end, 360);
  assert.equal(generatedRangeAt(ranges, 240), null);
});

test('keeps source cues playable and fills translations in place', () => {
  const source = [
    { id: 'a', start: 0, end: 2, original: 'Hello' },
    { id: 'b', start: 2, end: 4, original: 'World' },
  ];
  const merged = mergeProgressiveCues(source, [
    { ...source[0], translation: '你好' },
  ]);

  assert.equal(merged.length, 2);
  assert.equal(merged[0].translation, '你好');
  assert.equal(merged[0].translationPending, false);
  assert.equal(merged[1].translation, '');
  assert.equal(merged[1].translationPending, true);
});
