import { splitTranslationItems } from './translation-batch.js';

export const STREAM_TRANSLATION_BATCH_SIZE = 8;
export const MIN_SAFETY_BUFFER_SECONDS = 2 * 60;
export const MAX_SAFETY_BUFFER_SECONDS = 8 * 60;
export const BUFFER_PLANNING_HORIZON_SECONDS = 10 * 60;

export function buildProgressiveSegmentRanges(
  durationSeconds,
  startupSegmentSeconds = [60, 60, 120],
  steadySegmentSeconds = 180,
) {
  const duration = Math.max(0, Number(durationSeconds) || 0);
  const steady = Math.max(1, Number(steadySegmentSeconds) || 180);
  const startup = (Array.isArray(startupSegmentSeconds) ? startupSegmentSeconds : [])
    .map((seconds) => Math.max(1, Number(seconds) || 0))
    .filter(Boolean);
  const ranges = [];
  let start = 0;

  for (const seconds of startup) {
    if (start >= duration) break;
    const end = Math.min(duration, start + seconds);
    ranges.push({ start, end });
    start = end;
  }
  while (start < duration) {
    const end = Math.min(duration, start + steady);
    ranges.push({ start, end });
    start = end;
  }
  return ranges;
}

export function resumableProgressiveSegmentRanges(
  durationSeconds,
  resumeFromSeconds = 0,
  startupSegmentSeconds = [60, 60, 120],
  steadySegmentSeconds = 180,
) {
  const resumeAt = Math.max(0, Number(resumeFromSeconds) || 0);
  const allRanges = buildProgressiveSegmentRanges(
    durationSeconds,
    startupSegmentSeconds,
    steadySegmentSeconds,
  );
  return {
    totalSegments: allRanges.length,
    ranges: allRanges
      .map((range, index) => ({
        ...range,
        index,
        start: Math.max(range.start, resumeAt),
      }))
      .filter((range) => range.end > resumeAt + 0.05 && range.end > range.start),
  };
}

export function progressiveResumeCheckpoint({
  durationSeconds,
  completedSegmentIndexes,
  startupSegmentSeconds = [60, 60, 120],
  steadySegmentSeconds = 180,
} = {}) {
  const completed = new Set(Array.isArray(completedSegmentIndexes) ? completedSegmentIndexes : []);
  const ranges = buildProgressiveSegmentRanges(
    durationSeconds,
    startupSegmentSeconds,
    steadySegmentSeconds,
  );
  let checkpoint = 0;
  for (let index = 0; index < ranges.length; index += 1) {
    if (!completed.has(index)) break;
    checkpoint = ranges[index].end;
  }
  return checkpoint;
}

function bounded(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

export function progressiveTranslationConcurrency(configuredConcurrency = 2) {
  return Math.max(1, Math.min(3, Math.floor(Number(configuredConcurrency) || 2)));
}

export function splitTranslationBatches(cues, batchSize = STREAM_TRANSLATION_BATCH_SIZE, characterBudget = 6000) {
  return splitTranslationItems(cues, batchSize, characterBudget);
}

export function selectPrioritySegmentIndex(queue, {
  playbackTime = 0,
} = {}) {
  if (!Array.isArray(queue) || !queue.length) return -1;
  const playback = Math.max(0, Number(playbackTime) || 0);
  let bestIndex = 0;
  let bestScore = Infinity;

  queue.forEach((item, index) => {
    const segment = item?.segment || item || {};
    const start = Math.max(0, Number(segment.start) || 0);
    const end = Math.max(start, Number(segment.end) || start);
    const playbackDistance = playback < start
      ? start - playback
      : playback > end
        ? playback - end
        : 0;
    // The segment containing the requested playback point wins. After that,
    // future segments are ordered by distance (next 3 min, next 6 min, ...).
    // Work entirely behind the requested point receives a large penalty.
    const behindPenalty = end < playback ? 100_000 : 0;
    const score = behindPenalty + playbackDistance;
    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestIndex;
}

export function mergeGeneratedRange(ranges, nextRange, adjacencySeconds = 1) {
  const candidates = [
    ...(Array.isArray(ranges) ? ranges : []),
    nextRange,
  ]
    .map((range) => ({
      start: Math.max(0, Number(range?.start) || 0),
      end: Math.max(0, Number(range?.end) || 0),
    }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start);
  const merged = [];
  for (const range of candidates) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end + adjacencySeconds) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function generatedRangeAt(ranges, time) {
  const target = Math.max(0, Number(time) || 0);
  return (Array.isArray(ranges) ? ranges : []).find(
    (range) => target >= range.start - 0.05 && target <= range.end + 0.05,
  ) || null;
}

export function continuousGeneratedThrough(ranges) {
  const first = (Array.isArray(ranges) ? ranges : [])[0];
  return first && first.start <= 0.5 ? first.end : 0;
}

export function generatedCoverageSeconds(ranges) {
  return (Array.isArray(ranges) ? ranges : []).reduce(
    (total, range) => total + Math.max(0, range.end - range.start),
    0,
  );
}

export function mergeProgressiveCues(sourceCues, translatedCues) {
  const translatedById = new Map(
    (Array.isArray(translatedCues) ? translatedCues : []).map((cue) => [cue.id, cue]),
  );
  const sourceIds = new Set();
  const merged = (Array.isArray(sourceCues) ? sourceCues : []).map((cue) => {
    sourceIds.add(cue.id);
    const translated = translatedById.get(cue.id);
    return translated
      ? { ...cue, ...translated, translationPending: false }
      : { ...cue, translation: '', translationPending: true };
  });
  for (const cue of Array.isArray(translatedCues) ? translatedCues : []) {
    if (!sourceIds.has(cue.id)) merged.push({ ...cue, translationPending: false });
  }
  return merged.sort((left, right) => left.start - right.start || left.end - right.end);
}

export function estimateProgressiveBuffer({
  processedThrough,
  elapsedSeconds,
  durationSeconds = Infinity,
  minBufferSeconds = MIN_SAFETY_BUFFER_SECONDS,
  maxBufferSeconds = MAX_SAFETY_BUFFER_SECONDS,
  planningHorizonSeconds = BUFFER_PLANNING_HORIZON_SECONDS,
}) {
  const processed = Math.max(0, Number(processedThrough) || 0);
  const elapsed = Math.max(0.1, Number(elapsedSeconds) || 0.1);
  const duration = Number.isFinite(Number(durationSeconds)) && Number(durationSeconds) > 0
    ? Number(durationSeconds)
    : Infinity;
  const generationRate = processed / elapsed;
  const speedDeficit = Math.max(0, 1 - Math.min(1, generationRate));
  const dynamicTarget = 60 + (speedDeficit * Math.max(0, Number(planningHorizonSeconds) || 0));
  const targetBufferSeconds = Math.min(
    duration,
    bounded(dynamicTarget, Math.max(1, minBufferSeconds), Math.max(minBufferSeconds, maxBufferSeconds)),
  );
  const remainingBufferSeconds = Math.max(0, targetBufferSeconds - processed);
  const estimatedWaitSeconds = remainingBufferSeconds > 0 && generationRate > 0
    ? remainingBufferSeconds / generationRate
    : 0;

  return {
    generationRate,
    targetBufferSeconds,
    estimatedWaitSeconds,
    smoothReady: remainingBufferSeconds <= 0.5,
  };
}
