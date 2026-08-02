import { spawn } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { env, pipeline } from '@xenova/transformers';
import {
  buildLanguageTokenProbeConfig,
  languageTokenCandidatesFromBeams,
  summarizeLanguageTokenSamples,
} from './whisper-language-detection.js';

const require = createRequire(import.meta.url);
const DEFAULT_HOME = path.join(os.homedir(), '.lingoloop');
const SAMPLE_RATE = 16000;
const WINDOW_SECONDS = 30;
const WINDOW_OVERLAP_SECONDS = 5;
const MIN_CUE_SECONDS = 0.25;
const MAX_NEW_TOKENS = 128;
const DETECTION_SAMPLE_SECONDS = 20;
const MAX_DETECTION_SAMPLES = 3;
const MIN_LANGUAGE_EVIDENCE = 3;
const MIN_GAP_SECONDS = 1.2;
const GAP_CONTEXT_SECONDS = 0.75;
const MAX_GAP_RECOVERY_SECONDS = 28;
const MAX_GAP_RECOVERY_ATTEMPTS = 16;
const MODEL_LOAD_MAX_ATTEMPTS = 2;
const SEGMENT_CONTEXT_SECONDS = 8;

const QUALITY_MODELS = {
  fast: { id: 'Xenova/whisper-tiny', label: 'Tiny' },
  balanced: { id: 'Xenova/whisper-base', label: 'Base' },
  best: { id: 'Xenova/whisper-small', label: 'Small' },
};

const recognizerPromises = new Map();

function pathExists(filePath) {
  try {
    return Boolean(filePath && fs.existsSync(filePath));
  } catch {
    return false;
  }
}

function firstExisting(candidates) {
  return candidates.find(pathExists) || null;
}

function appRoot() {
  return process.cwd();
}

function packageValuePath(packageValue) {
  const candidate = typeof packageValue === 'string' ? packageValue : packageValue?.path;
  return typeof candidate === 'string' ? candidate : null;
}

function bundledFfmpegPath() {
  try {
    return packageValuePath(require('ffmpeg-static'));
  } catch {
    return null;
  }
}

function bundledFfprobePath() {
  try {
    return packageValuePath(require('@ffprobe-installer/ffprobe'));
  } catch {
    return null;
  }
}

function modelForQuality(quality = 'fast') {
  return QUALITY_MODELS[quality] || QUALITY_MODELS.fast;
}

function remoteModelDownloadsEnabled() {
  return process.env.LINGOLOOP_OFFLINE !== '1' && process.env.LINGOLOOP_ALLOW_REMOTE_MODELS !== 'false';
}

function modelCachePath(modelCacheDir, modelId) {
  return path.join(modelCacheDir, ...modelId.split('/'));
}

function modelIsCached(modelCacheDir, modelId) {
  const directory = modelCachePath(modelCacheDir, modelId);
  try {
    return fs.statSync(directory).isDirectory() && fs.readdirSync(directory).length > 0;
  } catch {
    return false;
  }
}

function configureTransformers(modelCacheDir) {
  fs.mkdirSync(modelCacheDir, { recursive: true });
  env.cacheDir = modelCacheDir;
  env.allowLocalModels = true;
  env.allowRemoteModels = remoteModelDownloadsEnabled();
  env.useFS = true;
  env.useFSCache = true;
}

export function lingoloopPaths() {
  const home = process.env.LINGOLOOP_HOME || DEFAULT_HOME;
  const binDir = path.join(home, 'bin');
  const modelsDir = process.env.LINGOLOOP_MODEL_DIR || path.join(home, 'models');
  const logsDir = process.env.LINGOLOOP_LOG_DIR || path.join(home, 'logs');
  const tempDir = process.env.LINGOLOOP_TEMP_DIR || path.join(home, 'tmp');
  const modelCacheDir = path.join(modelsDir, 'transformers');
  const bundledFfmpeg = bundledFfmpegPath();
  const bundledFfprobe = bundledFfprobePath();
  const ffmpeg = process.env.LINGOLOOP_FFMPEG_PATH || firstExisting([
    path.join(appRoot(), 'bin', 'ffmpeg'),
    bundledFfmpeg,
    path.join(binDir, 'ffmpeg'),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ]);
  const ffprobe = process.env.LINGOLOOP_FFPROBE_PATH || firstExisting([
    path.join(appRoot(), 'bin', 'ffprobe'),
    bundledFfprobe,
    path.join(binDir, 'ffprobe'),
    '/opt/homebrew/bin/ffprobe',
    '/usr/local/bin/ffprobe',
    '/usr/bin/ffprobe',
  ]);

  return { binDir, ffmpeg, ffprobe, home, logsDir, modelCacheDir, modelsDir, tempDir };
}

export function getWhisperStatus(quality = 'fast') {
  const paths = lingoloopPaths();
  const model = modelForQuality(quality);
  const cached = modelIsCached(paths.modelCacheDir, model.id);
  const downloadable = remoteModelDownloadsEnabled();
  const checks = {
    ffmpeg: pathExists(paths.ffmpeg),
    ffprobe: pathExists(paths.ffprobe),
    recognizer: typeof pipeline === 'function',
    model: cached || downloadable,
  };

  return {
    ready: Object.values(checks).every(Boolean),
    checks,
    model: {
      id: model.id,
      label: model.label,
      cached,
      downloadOnDemand: !cached && downloadable,
    },
    paths: {
      ffmpeg: paths.ffmpeg,
      ffprobe: paths.ffprobe,
      recognizer: '@xenova/transformers',
      // Keep this alias for older API consumers while the engine moves away
      // from a compiled whisper-cli binary.
      whisper: '@xenova/transformers',
      model: model.id,
      modelCacheDir: paths.modelCacheDir,
      modelsDir: paths.modelsDir,
      logsDir: paths.logsDir,
      tempDir: paths.tempDir,
      binDir: paths.binDir,
    },
  };
}

function ensureInsideWritableTemp(outputDir) {
  const resolved = path.resolve(outputDir);
  const allowedRoots = [
    path.resolve(lingoloopPaths().tempDir),
    path.resolve(os.tmpdir()),
  ];
  if (!allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    throw new Error('Output directory must be inside the LingoLoop temp folder.');
  }
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

export function buildWhisperJobPlan({ mediaPath, language = 'auto', quality = 'fast', jobId = `job-${Date.now()}` }) {
  if (!mediaPath || !path.isAbsolute(mediaPath)) {
    throw new Error('An absolute media path is required for local transcription.');
  }

  const status = getWhisperStatus(quality);
  const paths = lingoloopPaths();
  const outputDir = ensureInsideWritableTemp(path.join(paths.tempDir, jobId));
  const wavPath = path.join(outputDir, 'audio.wav');
  const logPath = path.join(paths.logsDir, `${jobId}.log`);
  const model = modelForQuality(quality);
  const lang = language === 'detect' ? 'auto' : language || 'auto';

  return {
    jobId,
    logPath,
    outputDir,
    wavPath,
    status,
    model,
    quality,
    language: lang,
    commands: {
      probe: {
        bin: paths.ffprobe,
        args: ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', mediaPath],
      },
      extractAudio: {
        bin: paths.ffmpeg,
        args: ['-nostdin', '-i', mediaPath, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', '-f', 'wav', wavPath],
      },
    },
  };
}

function appendJobLog(logPath, entry) {
  if (!logPath) return;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

function stageFailure(stage, message) {
  const error = new Error(message);
  error.stage = stage;
  error.code = 'NATIVE_STAGE_FAILED';
  return error;
}

function runCommand({ bin, args }, stage, logPath) {
  return new Promise((resolve, reject) => {
    if (!bin || !pathExists(bin)) {
      appendJobLog(logPath, { stage, event: 'unavailable', message: `${stage} binary is not installed.` });
      reject(stageFailure(stage, `${stage} binary is not installed.`));
      return;
    }

    appendJobLog(logPath, { stage, event: 'start', argv: [bin, ...args] });
    const startedAt = Date.now();
    const child = spawn(bin, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      appendJobLog(logPath, { stage, event: 'spawn-error', durationMs: Date.now() - startedAt, message: error.message });
      reject(stageFailure(stage, `${stage} could not start: ${error.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      const durationMs = Date.now() - startedAt;
      appendJobLog(logPath, { stage, event: 'exit', code, durationMs, stderrTail: stderr.slice(-1200) });
      if (code === 0) resolve({ stdout, stderr, durationMs });
      else reject(stageFailure(stage, `${stage} failed with exit code ${code}: ${stderr.slice(-1200)}`));
    });
  });
}

function readPcm16MonoWav(wavPath) {
  const wav = fs.readFileSync(wavPath);
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw stageFailure('audio', 'FFmpeg did not produce a valid WAV file.');
  }

  let offset = 12;
  let format = null;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const chunkLength = wav.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkStart + chunkLength > wav.length) break;

    if (chunkId === 'fmt ' && chunkLength >= 16) {
      format = {
        encoding: wav.readUInt16LE(chunkStart),
        channels: wav.readUInt16LE(chunkStart + 2),
        sampleRate: wav.readUInt32LE(chunkStart + 4),
        bitsPerSample: wav.readUInt16LE(chunkStart + 14),
      };
    } else if (chunkId === 'data') {
      dataOffset = chunkStart;
      dataLength = chunkLength;
      break;
    }
    offset = chunkStart + chunkLength + (chunkLength % 2);
  }

  if (!format || dataOffset < 0 || format.encoding !== 1 || format.channels !== 1 || format.sampleRate !== SAMPLE_RATE || format.bitsPerSample !== 16) {
    throw stageFailure('audio', 'Expected mono 16 kHz 16-bit PCM audio from FFmpeg.');
  }

  const sampleCount = Math.floor(dataLength / 2);
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = wav.readInt16LE(dataOffset + (index * 2)) / 32768;
  }
  return samples;
}

function createModelProgressLogger(logPath, modelId) {
  let lastPercent = -10;
  return (event) => {
    const progress = Number(event?.progress);
    const percent = Number.isFinite(progress) ? Math.floor(progress) : null;
    if (event?.status === 'progress' && percent !== null) {
      if (percent === 100 && lastPercent === 100) return;
      if (percent !== 100 && percent < lastPercent + 10) return;
    }
    if (percent !== null) lastPercent = percent;
    appendJobLog(logPath, {
      stage: 'model',
      event: event?.status || 'update',
      model: modelId,
      file: event?.file || null,
      percent,
    });
  };
}

async function getRecognizer(model, modelCacheDir, logPath) {
  configureTransformers(modelCacheDir);
  const existing = recognizerPromises.get(model.id);
  if (existing) return existing;

  const pending = (async () => {
    let lastError = null;
    for (let attempt = 1; attempt <= MODEL_LOAD_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await pipeline('automatic-speech-recognition', model.id, {
          quantized: true,
          progress_callback: createModelProgressLogger(logPath, model.id),
        });
      } catch (error) {
        lastError = error;
        appendJobLog(logPath, {
          stage: 'model',
          event: attempt < MODEL_LOAD_MAX_ATTEMPTS ? 'load-retry' : 'load-failed',
          model: model.id,
          attempt,
          maxAttempts: MODEL_LOAD_MAX_ATTEMPTS,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    throw lastError;
  })();
  recognizerPromises.set(model.id, pending);
  try {
    return await pending;
  } catch (error) {
    recognizerPromises.delete(model.id);
    throw error;
  }
}

export function transformerOutputToCues(output, durationSeconds = 0) {
  const chunks = Array.isArray(output?.chunks) ? output.chunks : [];
  const fallbackText = String(output?.text || '').trim();
  const rawCues = chunks.length ? chunks : (fallbackText ? [{ text: fallbackText, timestamp: [0, durationSeconds] }] : []);

  return rawCues
    .map((chunk, index) => {
      const original = compactRepeatedWords(String(chunk?.text || '').trim());
      if (!original) return null;
      const timestamp = Array.isArray(chunk?.timestamp) ? chunk.timestamp : [];
      const start = Number.isFinite(Number(timestamp[0])) ? Math.max(0, Number(timestamp[0])) : 0;
      const candidateEnd = Number(timestamp[1]);
      const end = Number.isFinite(candidateEnd) && candidateEnd > start
        ? candidateEnd
        : Math.max(start + 0.1, durationSeconds);
      return {
        id: `node-whisper-${index + 1}`,
        start,
        end,
        original,
        confidence: 0.86,
      };
    })
    .filter(Boolean);
}

function compactRepeatedWords(text) {
  const words = text.split(/\s+/).filter(Boolean);
  const compact = [];
  let previous = '';
  let repeats = 0;

  for (const word of words) {
    const normalized = word.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    if (normalized && normalized === previous) {
      repeats += 1;
      if (repeats > 2) continue;
    } else {
      previous = normalized;
      repeats = 0;
    }
    compact.push(word);
  }
  return compact.join(' ');
}

export function whisperHallucinationReason(text) {
  const normalizedText = String(text || '').normalize('NFKC').trim();
  const compact = normalizedText
    .replace(/[^\p{L}\p{N}]+/gu, '');
  const characters = Array.from(compact);
  const marker = normalizedText
    .toLocaleLowerCase()
    .replace(/[\s()[\]{}<>（）［］【】「」『』]/gu, '');
  if (['笑', '笑い', 'laughter', 'laughs', 'music', '音楽', '拍手', 'applause'].includes(marker)) {
    return 'the cue contains only a non-speech sound marker';
  }
  if (characters.length >= 5 && new Set(characters).size === 1) {
    return 'the cue repeats only one character';
  }
  if (characters.length < 12) return null;

  if (/(.)\1{7,}/u.test(compact)) {
    return 'the same character repeats at least eight times';
  }

  const exactRepeatedUnit = compact.match(/^(.{1,4})\1{4,}$/u);
  if (exactRepeatedUnit) {
    return `a ${Array.from(exactRepeatedUnit[1]).length}-character pattern repeats throughout the cue`;
  }

  const frequencies = new Map();
  for (const character of characters) {
    frequencies.set(character, (frequencies.get(character) || 0) + 1);
  }
  const dominantCount = Math.max(...frequencies.values());
  if (frequencies.size <= 3 && dominantCount / characters.length >= 0.7) {
    return 'the cue is dominated by only a few repeated characters';
  }

  return null;
}

function scriptLanguageEvidence(cues) {
  const text = cues.map((cue) => cue.original).join(' ').normalize('NFKC');
  const count = (pattern) => Array.from(text.matchAll(pattern)).length;
  const kana = count(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  const hangul = count(/\p{Script=Hangul}/gu);
  const han = count(/\p{Script=Han}/gu);
  const latin = count(/\p{Script=Latin}/gu);
  const relevant = kana + hangul + han + latin;

  let language = null;
  let evidence = 0;
  // Even a short, valid kana fragment is decisive: Chinese does not use kana.
  // This prevents noisy auto-mode Han output from outvoting a real Japanese
  // phrase such as the logged "よし" sample.
  if (kana >= 2) {
    language = 'ja';
    evidence = kana + han;
  } else if (hangul >= 2) {
    language = 'ko';
    evidence = hangul;
  } else if (kana === 0 && hangul === 0 && han >= MIN_LANGUAGE_EVIDENCE) {
    language = 'zh';
    evidence = han;
  }

  // Script alone cannot distinguish supported Latin languages. A conservative
  // stop-word vote works well on the combined 60-second sample and deliberately
  // returns null when the winner is weak or ambiguous.
  let latinVote = null;
  if (!language && latin >= 12) {
    const words = text.toLocaleLowerCase().match(/\p{Script=Latin}+/gu) || [];
    const dictionaries = {
      en: new Set(['the', 'and', 'you', 'your', 'to', 'is', 'are', 'of', 'in', 'that', 'this', 'it', 'for', 'with', 'was', 'have', 'not']),
      es: new Set(['el', 'la', 'los', 'las', 'que', 'una', 'es', 'por', 'para', 'con', 'como', 'pero', 'del', 'esta', 'este']),
      fr: new Set(['le', 'la', 'les', 'des', 'que', 'une', 'est', 'pour', 'avec', 'dans', 'pas', 'mais', 'vous', 'nous', 'sur']),
      de: new Set(['der', 'die', 'das', 'den', 'dem', 'und', 'ist', 'ein', 'eine', 'mit', 'nicht', 'für', 'auf', 'ich', 'wir']),
    };
    const scores = Object.entries(dictionaries)
      .map(([candidate, dictionary]) => ({
        language: candidate,
        score: words.reduce((total, word) => total + (dictionary.has(word) ? 1 : 0), 0),
      }))
      .sort((left, right) => right.score - left.score);
    if (scores[0].score >= 4 && scores[0].score >= scores[1].score + 2) {
      language = scores[0].language;
      evidence = scores[0].score;
      latinVote = { scores, wordCount: words.length };
    }
  }

  return {
    language,
    confidence: language
      ? Math.min(0.99, 0.7 + (evidence / Math.max(12, language && latinVote ? latinVote.wordCount : relevant)) * 0.29)
      : 0,
    evidence: { kana, hangul, han, latin, total: relevant, latinVote },
  };
}

function inferLanguageFromScript(cues) {
  return scriptLanguageEvidence(cues).language;
}

function assessWhisperCues(cues) {
  const assessed = cues.map((cue) => ({
    cue,
    reason: whisperHallucinationReason(cue.original),
  }));
  return {
    accepted: assessed.filter((entry) => !entry.reason).map((entry) => entry.cue),
    rejected: assessed.filter((entry) => entry.reason),
  };
}

function audioWindows(samples) {
  const windowSamples = WINDOW_SECONDS * SAMPLE_RATE;
  const stepSamples = (WINDOW_SECONDS - WINDOW_OVERLAP_SECONDS) * SAMPLE_RATE;
  const windows = [];
  for (let offset = 0; offset < samples.length; offset += stepSamples) {
    windows.push({
      offsetSeconds: offset / SAMPLE_RATE,
      samples: samples.subarray(offset, Math.min(samples.length, offset + windowSamples)),
    });
    if (offset + windowSamples >= samples.length) break;
  }
  return windows;
}

function normalizedWords(text) {
  return String(text || '')
    .split(/\s+/)
    .map((word) => word.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''))
    .filter(Boolean);
}

function trimRepeatedPrefix(previousText, currentText) {
  const previousWords = normalizedWords(previousText);
  const currentRawWords = String(currentText || '').split(/\s+/).filter(Boolean);
  const currentWords = normalizedWords(currentText);
  const maxOverlap = Math.min(10, previousWords.length, currentWords.length);

  for (let length = maxOverlap; length >= 2; length -= 1) {
    const previousSuffix = previousWords.slice(-length).join(' ');
    const currentPrefix = currentWords.slice(0, length).join(' ');
    if (previousSuffix === currentPrefix) return currentRawWords.slice(length).join(' ');
  }
  return currentText;
}

function stitchWindowCues(cues, durationSeconds) {
  const sorted = cues
    .map((cue) => ({
      ...cue,
      start: Math.max(0, Math.min(durationSeconds, cue.start)),
      end: Math.max(0, Math.min(durationSeconds, cue.end)),
    }))
    .filter((cue) => cue.end > cue.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const stitched = [];
  for (const rawCue of sorted) {
    const cue = { ...rawCue };
    const previous = stitched[stitched.length - 1];
    if (previous && cue.start <= previous.end + WINDOW_OVERLAP_SECONDS) {
      cue.original = trimRepeatedPrefix(previous.original, cue.original).trim();
      if (!cue.original) continue;
    }
    if (previous && cue.start < previous.end) {
      const boundary = Math.max(
        previous.start + 0.08,
        Math.min(cue.end - 0.08, (previous.end + cue.start) / 2),
      );
      if (cue.end - boundary < MIN_CUE_SECONDS) continue;
      previous.end = boundary;
      cue.start = boundary;
    }
    if (cue.end - cue.start >= MIN_CUE_SECONDS) stitched.push(cue);
  }
  return stitched;
}

function recognitionOptions(language) {
  const options = {
    return_timestamps: true,
    max_new_tokens: MAX_NEW_TOKENS,
    no_repeat_ngram_size: 5,
    repetition_penalty: 1.1,
    task: 'transcribe',
  };
  if (language !== 'auto') options.language = language;
  return options;
}

async function recognizeSamples(plan, samples, {
  model,
  language,
  logStage = 'recognize',
  onWindowProgress,
}) {
  const durationSeconds = samples.length / SAMPLE_RATE;
  const recognizer = await getRecognizer(model, lingoloopPaths().modelCacheDir, plan.logPath);
  const windows = audioWindows(samples);
  appendJobLog(plan.logPath, {
    stage: logStage,
    event: 'start',
    model: model.id,
    language,
    durationSeconds,
    windows: windows.length,
  });
  const startedAt = Date.now();
  // Prevent Whisper from filling a low-information window with the same token
  // indefinitely. The post-generation hallucination filter remains the final
  // safety net.
  const options = recognitionOptions(language);
  const cues = [];
  let rejectedHallucinations = 0;
  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];
    const ownershipStart = index === 0
      ? 0
      : window.offsetSeconds + (WINDOW_OVERLAP_SECONDS / 2);
    const ownershipEnd = index === windows.length - 1
      ? durationSeconds
      : window.offsetSeconds + WINDOW_SECONDS - (WINDOW_OVERLAP_SECONDS / 2);
    appendJobLog(plan.logPath, {
      stage: logStage,
      event: 'window-start',
      index: index + 1,
      total: windows.length,
      offsetSeconds: window.offsetSeconds,
      ownershipStart,
      ownershipEnd,
    });
    // Transformers.js augments the options object with Whisper prompt tokens.
    // Each window needs a fresh object or the next call rejects that carried state.
    let output = await recognizer(window.samples, { ...options });
    const windowDuration = window.samples.length / SAMPLE_RATE;
    let modelWindowCues = transformerOutputToCues(output, windowDuration);
    let assessment = assessWhisperCues(modelWindowCues);

    // Transformers.js does not expose a reliable detected-language result.
    // If auto mode produces only obvious garbage but its script gives us a
    // strong hint, retry this window once with that language forced.
    if (language === 'auto' && assessment.accepted.length === 0 && assessment.rejected.length > 0) {
      const inferredLanguage = inferLanguageFromScript(modelWindowCues);
      if (inferredLanguage) {
        appendJobLog(plan.logPath, {
          stage: logStage,
          event: 'auto-language-retry',
          index: index + 1,
          inferredLanguage,
          rejectedBeforeRetry: assessment.rejected.length,
        });
        output = await recognizer(window.samples, { ...options, language: inferredLanguage });
        modelWindowCues = transformerOutputToCues(output, windowDuration);
        assessment = assessWhisperCues(modelWindowCues);
        appendJobLog(plan.logPath, {
          stage: logStage,
          event: 'auto-language-retry-complete',
          index: index + 1,
          inferredLanguage,
          modelCueCount: modelWindowCues.length,
          accepted: assessment.accepted.length,
          rejected: assessment.rejected.length,
        });
      }
    }

    const rejectedWindowCues = assessment.rejected;
    rejectedHallucinations += rejectedWindowCues.length;
    if (rejectedWindowCues.length) {
      appendJobLog(plan.logPath, {
        stage: logStage,
        event: 'hallucination-filter',
        index: index + 1,
        rejected: rejectedWindowCues.length,
        cues: rejectedWindowCues.map(({ cue, reason }) => ({
          reason,
          text: cue.original.slice(0, 160),
        })),
      });
    }
    const rawWindowCues = assessment.accepted
      .map((cue, cueIndex) => ({
        ...cue,
        id: `node-whisper-${index + 1}-${cueIndex + 1}`,
        start: cue.start + window.offsetSeconds,
        end: cue.end + window.offsetSeconds,
      }));
    // Each overlapping window owns only its central time region. The overlap
    // gives Whisper context across a 30-second boundary without emitting the
    // same spoken phrase twice.
    const windowCues = rawWindowCues.filter((cue) => {
      const midpoint = cue.start + ((cue.end - cue.start) / 2);
      return midpoint >= ownershipStart
        && (index === windows.length - 1 ? midpoint <= ownershipEnd : midpoint < ownershipEnd);
    });
    cues.push(...windowCues);
    appendJobLog(plan.logPath, {
      stage: logStage,
      event: 'window-complete',
      index: index + 1,
      total: windows.length,
      modelCueCount: modelWindowCues.length,
      rejectedHallucinations: rejectedWindowCues.length,
      rawCueCount: rawWindowCues.length,
      cueCount: windowCues.length,
    });
    onWindowProgress?.({ index: index + 1, total: windows.length });
  }
  const stitchedCues = stitchWindowCues(cues, durationSeconds);
  const durationMs = Date.now() - startedAt;
  appendJobLog(plan.logPath, {
    stage: logStage,
    event: 'complete',
    durationMs,
    cueCount: stitchedCues.length,
    rejectedHallucinations,
  });
  return { cues: stitchedCues, durationMs, rejectedHallucinations };
}

function representativeSampleRanges(durationSeconds) {
  if (durationSeconds <= DETECTION_SAMPLE_SECONDS) {
    return [{ start: 0, end: durationSeconds }];
  }
  const maxStart = Math.max(0, durationSeconds - DETECTION_SAMPLE_SECONDS);
  const starts = [
    Math.min(maxStart, Math.max(0, durationSeconds * 0.08)),
    Math.min(maxStart, Math.max(0, (durationSeconds - DETECTION_SAMPLE_SECONDS) / 2)),
    Math.min(maxStart, Math.max(0, durationSeconds * 0.82 - DETECTION_SAMPLE_SECONDS / 2)),
  ];
  return [...new Set(starts.map((value) => Number(value.toFixed(3))))]
    .slice(0, MAX_DETECTION_SAMPLES)
    .map((start) => ({ start, end: Math.min(durationSeconds, start + DETECTION_SAMPLE_SECONDS) }));
}

async function extractRepresentativeDetectionSamples(plan, mediaPath, durationSeconds) {
  const ranges = representativeSampleRanges(durationSeconds);
  const sampleChunks = [];
  let totalSamples = 0;

  appendJobLog(plan.logPath, {
    stage: 'language-detection',
    event: 'whole-media-fallback-start',
    ranges,
  });
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    const wavPath = path.join(plan.outputDir, `language-sample-${index + 1}.wav`);
    await runCommand({
      bin: plan.commands.extractAudio.bin,
      args: [
        '-nostdin',
        '-ss', String(range.start),
        '-t', String(Math.max(0.1, range.end - range.start)),
        '-i', mediaPath,
        '-vn',
        '-ac', '1',
        '-ar', String(SAMPLE_RATE),
        '-c:a', 'pcm_s16le',
        '-f', 'wav',
        wavPath,
      ],
    }, `ffmpeg-language-sample-${index + 1}`, plan.logPath);
    const samples = readPcm16MonoWav(wavPath);
    sampleChunks.push(samples);
    totalSamples += samples.length;
  }

  const combined = new Float32Array(totalSamples);
  let offset = 0;
  for (const samples of sampleChunks) {
    combined.set(samples, offset);
    offset += samples.length;
  }
  appendJobLog(plan.logPath, {
    stage: 'language-detection',
    event: 'whole-media-fallback-ready',
    durationSeconds: combined.length / SAMPLE_RATE,
    sampleCount: ranges.length,
  });
  return combined;
}

async function detectSpokenLanguage(plan, samples, rangesOverride = null) {
  const durationSeconds = samples.length / SAMPLE_RATE;
  const recognizer = await getRecognizer(plan.model, lingoloopPaths().modelCacheDir, plan.logPath);
  const ranges = rangesOverride || representativeSampleRanges(durationSeconds);
  const tokenSamples = [];
  const generationConfig = recognizer?.model?.generation_config || {};
  const probeConfig = buildLanguageTokenProbeConfig(generationConfig);
  appendJobLog(plan.logPath, {
    stage: 'language-detection',
    event: 'start',
    model: plan.model.id,
    method: 'whisper-language-token',
    ranges,
  });

  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    const startSample = Math.floor(range.start * SAMPLE_RATE);
    const endSample = Math.min(samples.length, Math.ceil(range.end * SAMPLE_RATE));
    const sample = samples.subarray(startSample, endSample);
    const processed = await recognizer.processor(sample);
    let latestBeams = [];
    await recognizer.model.generate(processed.input_features, {
      ...probeConfig,
      callback_function: (beams) => {
        latestBeams = beams;
      },
    });
    const candidates = languageTokenCandidatesFromBeams(
      latestBeams,
      generationConfig.lang_to_id,
    );
    tokenSamples.push({ range, candidates });
    appendJobLog(plan.logPath, {
      stage: 'language-detection',
      event: 'sample-complete',
      index: index + 1,
      range,
      candidates: candidates.slice(0, 5),
    });
  }

  const result = summarizeLanguageTokenSamples(tokenSamples);
  appendJobLog(plan.logPath, {
    stage: 'language-detection',
    event: 'complete',
    ...result,
  });
  return result;
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * fraction)))];
}

function frameEnergyProfile(samples) {
  const frameSamples = Math.round(SAMPLE_RATE * 0.1);
  const energies = [];
  for (let offset = 0; offset < samples.length; offset += frameSamples) {
    const end = Math.min(samples.length, offset + frameSamples);
    let sumSquares = 0;
    for (let index = offset; index < end; index += 1) sumSquares += samples[index] * samples[index];
    energies.push(Math.sqrt(sumSquares / Math.max(1, end - offset)));
  }
  const noiseFloor = percentile(energies, 0.2);
  const activeLevel = percentile(energies, 0.75);
  const threshold = Math.max(0.004, noiseFloor * 2.5, activeLevel * 0.18);
  return { energies, frameSeconds: frameSamples / SAMPLE_RATE, threshold };
}

function uncoveredRanges(cues, durationSeconds) {
  const sorted = [...cues].sort((left, right) => left.start - right.start);
  const ranges = [];
  let cursor = 0;
  for (const cue of sorted) {
    if (cue.start - cursor >= MIN_GAP_SECONDS) ranges.push({ start: cursor, end: cue.start });
    cursor = Math.max(cursor, cue.end);
  }
  if (durationSeconds - cursor >= MIN_GAP_SECONDS) ranges.push({ start: cursor, end: durationSeconds });
  return ranges;
}

function speechGapCandidates(samples, cues) {
  const durationSeconds = samples.length / SAMPLE_RATE;
  const profile = frameEnergyProfile(samples);
  const candidates = [];
  for (const range of uncoveredRanges(cues, durationSeconds)) {
    const firstFrame = Math.max(0, Math.floor(range.start / profile.frameSeconds));
    const lastFrame = Math.min(profile.energies.length, Math.ceil(range.end / profile.frameSeconds));
    const frames = profile.energies.slice(firstFrame, lastFrame);
    const active = frames.map((value) => value >= profile.threshold);
    const activeRatio = active.filter(Boolean).length / Math.max(1, active.length);
    let longestRun = 0;
    let currentRun = 0;
    for (const isActive of active) {
      currentRun = isActive ? currentRun + 1 : 0;
      longestRun = Math.max(longestRun, currentRun);
    }
    if (activeRatio < 0.18 || longestRun * profile.frameSeconds < 0.3) continue;

    for (let start = range.start; start < range.end; start += MAX_GAP_RECOVERY_SECONDS) {
      candidates.push({
        start,
        end: Math.min(range.end, start + MAX_GAP_RECOVERY_SECONDS),
        activeRatio: Number(activeRatio.toFixed(3)),
      });
      if (candidates.length >= MAX_GAP_RECOVERY_ATTEMPTS) return { candidates, threshold: profile.threshold };
    }
  }
  return { candidates, threshold: profile.threshold };
}

async function recoverSpeechGaps(plan, samples, cues, { model, language }) {
  const durationSeconds = samples.length / SAMPLE_RATE;
  const { candidates, threshold } = speechGapCandidates(samples, cues);
  appendJobLog(plan.logPath, {
    stage: 'gap-recovery',
    event: 'start',
    threshold,
    candidates,
  });
  if (!candidates.length) return { cues, recoveredCueCount: 0, attemptedGaps: 0, durationMs: 0 };

  const startedAt = Date.now();
  const recognizer = await getRecognizer(model, lingoloopPaths().modelCacheDir, plan.logPath);
  const recovered = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const gap = candidates[index];
    const paddedStart = Math.max(0, gap.start - GAP_CONTEXT_SECONDS);
    const paddedEnd = Math.min(durationSeconds, gap.end + GAP_CONTEXT_SECONDS);
    const segment = samples.subarray(
      Math.floor(paddedStart * SAMPLE_RATE),
      Math.ceil(paddedEnd * SAMPLE_RATE),
    );
    const output = await recognizer(segment, { ...recognitionOptions(language) });
    const assessment = assessWhisperCues(transformerOutputToCues(output, segment.length / SAMPLE_RATE));
    const gapCues = assessment.accepted
      .map((cue, cueIndex) => ({
        ...cue,
        id: `node-whisper-gap-${index + 1}-${cueIndex + 1}`,
        start: cue.start + paddedStart,
        end: cue.end + paddedStart,
      }))
      .filter((cue) => {
        const midpoint = cue.start + ((cue.end - cue.start) / 2);
        return midpoint >= gap.start && midpoint <= gap.end;
      });
    recovered.push(...gapCues);
    appendJobLog(plan.logPath, {
      stage: 'gap-recovery',
      event: 'gap-complete',
      index: index + 1,
      gap,
      recovered: gapCues.length,
      rejected: assessment.rejected.length,
    });
  }
  const merged = stitchWindowCues([...cues, ...recovered], durationSeconds);
  const durationMs = Date.now() - startedAt;
  appendJobLog(plan.logPath, {
    stage: 'gap-recovery',
    event: 'complete',
    attemptedGaps: candidates.length,
    recoveredCueCount: recovered.length,
    finalCueCount: merged.length,
    durationMs,
  });
  return { cues: merged, recoveredCueCount: recovered.length, attemptedGaps: candidates.length, durationMs };
}

export async function runWhisperJob(jobSpec) {
  const plan = buildWhisperJobPlan(jobSpec);
  if (!plan.status.ready) {
    const checks = plan.status?.checks && typeof plan.status.checks === 'object' ? plan.status.checks : {};
    const missing = Object.entries(checks).filter(([, ready]) => !ready).map(([name]) => name);
    const error = stageFailure('preflight', `Local transcription is not ready. Missing: ${missing.join(', ')}.`);
    error.jobId = plan.jobId;
    error.logPath = plan.logPath;
    throw error;
  }

  const stages = [];
  try {
    appendJobLog(plan.logPath, {
      event: 'job-start',
      jobId: plan.jobId,
      outputDir: plan.outputDir,
      model: plan.model.id,
      language: plan.language,
    });

    const probe = await runCommand(plan.commands.probe, 'ffprobe', plan.logPath);
    let mediaDurationSeconds = 0;
    try {
      const probeData = JSON.parse(probe.stdout);
      mediaDurationSeconds = Number(probeData?.format?.duration) || 0;
      appendJobLog(plan.logPath, {
        stage: 'ffprobe',
        event: 'media-summary',
        formatDurationSeconds: Number(probeData?.format?.duration) || null,
        audioStreams: (probeData?.streams || [])
          .filter((stream) => stream.codec_type === 'audio')
          .map((stream) => ({
            index: stream.index,
            codec: stream.codec_name,
            durationSeconds: Number(stream.duration) || null,
            sampleRate: Number(stream.sample_rate) || null,
            channels: stream.channels || null,
            language: stream.tags?.language || null,
            default: Boolean(stream.disposition?.default),
          })),
      });
    } catch (error) {
      appendJobLog(plan.logPath, {
        stage: 'ffprobe',
        event: 'summary-unavailable',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    stages.push({ id: 'ffprobe', label: 'Probe media', durationMs: probe.durationMs });

    const segmentSeconds = Math.max(0, Number(jobSpec.segmentSeconds) || 0);
    if (segmentSeconds > 0 && mediaDurationSeconds > 0) {
      return await runSegmentedWhisperJob(plan, {
        mediaPath: jobSpec.mediaPath,
        durationSeconds: mediaDurationSeconds,
        segmentSeconds,
        firstSegmentSeconds: Math.max(0, Number(jobSpec.firstSegmentSeconds) || segmentSeconds),
        onProgress: jobSpec.onProgress,
        onSegment: jobSpec.onSegment,
        signal: jobSpec.signal,
        stages,
      });
    }

    const audio = await runCommand(plan.commands.extractAudio, 'ffmpeg', plan.logPath);
    stages.push({ id: 'ffmpeg', label: 'Extract mono 16 kHz audio', durationMs: audio.durationMs });

    const samples = readPcm16MonoWav(plan.wavPath);
    let detectedLanguage = plan.language === 'auto' ? null : plan.language;
    let languageDetection = null;
    let effectiveQuality = plan.quality;
    let effectiveModel = plan.model;
    let autoUpgraded = false;

    if (plan.language === 'auto') {
      languageDetection = await detectSpokenLanguage(plan, samples);
      detectedLanguage = languageDetection.language;
      if (!detectedLanguage) {
        throw stageFailure(
          'language-detection',
          `Auto-detect could not identify the spoken language confidently (${Math.round((languageDetection.confidence || 0) * 100)}%). Choose the spoken language explicitly and regenerate the subtitles.`,
        );
      }
      if (detectedLanguage) {
        const bestStatus = getWhisperStatus('best');
        if (!bestStatus.ready) {
          throw stageFailure(
            'preflight',
            `Smart Auto detected ${detectedLanguage}, but the Best transcription model is unavailable.`,
          );
        }
        effectiveQuality = 'best';
        effectiveModel = modelForQuality('best');
        autoUpgraded = plan.quality !== 'best';
        appendJobLog(plan.logPath, {
          stage: 'language-detection',
          event: 'smart-auto-upgrade',
          detectedLanguage,
          fromQuality: plan.quality,
          toQuality: effectiveQuality,
          fromModel: plan.model.id,
          toModel: effectiveModel.id,
        });
      }
    }

    const recognized = await recognizeSamples(plan, samples, {
      model: effectiveModel,
      language: detectedLanguage || plan.language,
      logStage: detectedLanguage && plan.language === 'auto' ? 'recognize-smart-auto' : 'recognize',
    });
    const recovered = await recoverSpeechGaps(plan, samples, recognized.cues, {
      model: effectiveModel,
      language: detectedLanguage || plan.language,
    });
    stages.push({
      id: 'recognize',
      label: 'Recognize speech with local Whisper',
      durationMs: recognized.durationMs,
      rejectedHallucinations: recognized.rejectedHallucinations,
    });
    stages.push({
      id: 'gap-recovery',
      label: 'Recover speech regions without subtitles',
      durationMs: recovered.durationMs,
      attemptedGaps: recovered.attemptedGaps,
      recoveredCueCount: recovered.recoveredCueCount,
    });
    stages.push({ id: 'cues', label: 'Parse timestamped cues', durationMs: 0, count: recovered.cues.length });
    appendJobLog(plan.logPath, {
      event: 'job-complete',
      cueCount: recovered.cues.length,
      detectedLanguage,
      effectiveQuality,
      autoUpgraded,
      recoveredCueCount: recovered.recoveredCueCount,
    });
    return {
      cues: recovered.cues,
      detectedLanguage,
      effectiveQuality,
      autoUpgraded,
      languageDetection,
      recoveredCueCount: recovered.recoveredCueCount,
      attemptedGapRecoveries: recovered.attemptedGaps,
      rejectedHallucinations: recognized.rejectedHallucinations,
      plan,
      stages,
    };
  } catch (error) {
    error.jobId = error.jobId || plan.jobId;
    error.logPath = error.logPath || plan.logPath;
    appendJobLog(plan.logPath, { event: 'job-failed', stage: error.stage || 'unknown', message: error.message });
    throw error;
  } finally {
    // Keep disk usage low: the extracted WAV (~2 MB per minute of video) is
    // only needed during recognition. Remove the whole job temp dir; the
    // small JSONL log in logsDir is kept for debugging.
    try {
      fs.rmSync(plan.outputDir, { recursive: true, force: true });
    } catch {
      // Best effort — never fail the job over cleanup.
    }
    cleanupStaleJobDirs(plan.outputDir);
  }
}

async function runSegmentedWhisperJob(plan, {
  mediaPath,
  durationSeconds,
  segmentSeconds,
  firstSegmentSeconds,
  onProgress,
  onSegment,
  signal,
  stages,
}) {
  const initialEnd = Math.min(durationSeconds, firstSegmentSeconds || segmentSeconds);
  const segmentRanges = [{ start: 0, end: initialEnd }];
  for (let start = initialEnd; start < durationSeconds; start += segmentSeconds) {
    segmentRanges.push({ start, end: Math.min(durationSeconds, start + segmentSeconds) });
  }
  const totalSegments = segmentRanges.length;
  const allCues = [];
  let detectedLanguage = plan.language === 'auto' ? null : plan.language;
  let languageDetection = null;
  let effectiveQuality = plan.quality;
  let effectiveModel = plan.model;
  let autoUpgraded = false;
  let recoveredCueCount = 0;
  let attemptedGapRecoveries = 0;
  let rejectedHallucinations = 0;

  appendJobLog(plan.logPath, {
    event: 'segmented-job-start',
    durationSeconds,
    segmentSeconds,
    firstSegmentSeconds: initialEnd,
    totalSegments,
  });

  for (let index = 0; index < totalSegments; index += 1) {
    if (signal?.aborted) {
      const error = stageFailure('cancelled', 'Transcription was cancelled.');
      error.code = 'TRANSCRIPTION_CANCELLED';
      throw error;
    }
    const { start, end } = segmentRanges[index];
    const contextStart = Math.max(0, start - SEGMENT_CONTEXT_SECONDS);
    const contextEnd = Math.min(durationSeconds, end + SEGMENT_CONTEXT_SECONDS);
    const chunkDuration = contextEnd - contextStart;
    const wavPath = path.join(plan.outputDir, `audio-${String(index + 1).padStart(3, '0')}.wav`);
    const extractCommand = {
      bin: plan.commands.extractAudio.bin,
      args: [
        '-nostdin',
        '-ss', String(contextStart),
        '-t', String(chunkDuration),
        '-i', mediaPath,
        '-vn',
        '-ac', '1',
        '-ar', String(SAMPLE_RATE),
        '-c:a', 'pcm_s16le',
        '-f', 'wav',
        wavPath,
      ],
    };

    onProgress?.({
      type: 'segment-start',
      index,
      totalSegments,
      start,
      end,
      contextStart,
      contextEnd,
      durationSeconds,
      firstSegmentSeconds: initialEnd,
    });
    const audio = await runCommand(extractCommand, `ffmpeg-segment-${index + 1}`, plan.logPath);
    const samples = readPcm16MonoWav(wavPath);

    if (index === 0 && plan.language === 'auto') {
      languageDetection = await detectSpokenLanguage(plan, samples);
      detectedLanguage = languageDetection.language;
      if (!detectedLanguage && durationSeconds > chunkDuration) {
        const representativeSamples = await extractRepresentativeDetectionSamples(
          plan,
          mediaPath,
          durationSeconds,
        );
        languageDetection = await detectSpokenLanguage(
          plan,
          representativeSamples,
          representativeSampleRanges(durationSeconds).map((_, sampleIndex) => ({
            start: sampleIndex * DETECTION_SAMPLE_SECONDS,
            end: (sampleIndex + 1) * DETECTION_SAMPLE_SECONDS,
          })),
        );
        detectedLanguage = languageDetection.language;
      }
      if (!detectedLanguage) {
        throw stageFailure(
          'language-detection',
          `Auto-detect could not identify the spoken language confidently (${Math.round((languageDetection.confidence || 0) * 100)}%). Choose the spoken language explicitly and regenerate the subtitles.`,
        );
      }
      const bestStatus = getWhisperStatus('best');
      if (!bestStatus.ready) {
        throw stageFailure('preflight', `Smart Auto detected ${detectedLanguage}, but the Best transcription model is unavailable.`);
      }
      effectiveQuality = 'best';
      effectiveModel = modelForQuality('best');
      autoUpgraded = plan.quality !== 'best';
    }

    const recognized = await recognizeSamples(plan, samples, {
      model: effectiveModel,
      language: detectedLanguage || plan.language,
      logStage: `recognize-segment-${index + 1}`,
      onWindowProgress: ({ index: windowIndex, total: totalWindows }) => onProgress?.({
        type: 'segment-progress',
        index,
        totalSegments,
        windowIndex,
        totalWindows,
        start,
        end,
        contextStart,
        contextEnd,
        durationSeconds,
        firstSegmentSeconds: initialEnd,
      }),
    });
    const recovered = await recoverSpeechGaps(plan, samples, recognized.cues, {
      model: effectiveModel,
      language: detectedLanguage || plan.language,
    });
    const segmentCues = recovered.cues
      .map((cue, cueIndex) => ({
        ...cue,
        id: `node-whisper-segment-${index + 1}-${cueIndex + 1}`,
        start: cue.start + contextStart,
        end: Math.min(durationSeconds, cue.end + contextStart),
      }))
      .filter((cue) => {
        const midpoint = cue.start + ((cue.end - cue.start) / 2);
        return midpoint >= start
          && (index === totalSegments - 1 ? midpoint <= end : midpoint < end);
      });

    allCues.push(...segmentCues);
    recoveredCueCount += recovered.recoveredCueCount;
    attemptedGapRecoveries += recovered.attemptedGaps;
    rejectedHallucinations += recognized.rejectedHallucinations;
    stages.push({
      id: `segment-${index + 1}`,
      label: `Process segment ${index + 1} of ${totalSegments}`,
      durationMs: audio.durationMs + recognized.durationMs + recovered.durationMs,
      count: segmentCues.length,
    });

    const segmentResult = {
      index,
      totalSegments,
      start,
      end,
      contextStart,
      contextEnd,
      contextSeconds: SEGMENT_CONTEXT_SECONDS,
      durationSeconds,
      firstSegmentSeconds: initialEnd,
      cues: segmentCues,
      detectedLanguage,
      effectiveQuality,
      autoUpgraded,
      languageDetection,
      recoveredCueCount: recovered.recoveredCueCount,
      attemptedGapRecoveries: recovered.attemptedGaps,
      rejectedHallucinations: recognized.rejectedHallucinations,
    };
    await onSegment?.(segmentResult);
    onProgress?.({ type: 'segment-complete', ...segmentResult, cues: undefined });
    try {
      fs.rmSync(wavPath, { force: true });
    } catch {
      // The job-level cleanup below remains the final safety net.
    }
  }

  const cues = stitchWindowCues(allCues, durationSeconds);
  appendJobLog(plan.logPath, {
    event: 'segmented-job-complete',
    cueCount: cues.length,
    totalSegments,
    detectedLanguage,
    effectiveQuality,
  });
  return {
    cues,
    detectedLanguage,
    effectiveQuality,
    autoUpgraded,
    languageDetection,
    recoveredCueCount,
    attemptedGapRecoveries,
    rejectedHallucinations,
    plan,
    stages,
    durationSeconds,
    segmentSeconds,
    firstSegmentSeconds: initialEnd,
    totalSegments,
  };
}

// Sweep any temp job dirs older than a day that a crashed run left behind.
function cleanupStaleJobDirs(currentOutputDir) {
  try {
    const { tempDir } = lingoloopPaths();
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const entry of fs.readdirSync(tempDir)) {
      const full = path.join(tempDir, entry);
      if (full === currentOutputDir) continue;
      const stats = fs.statSync(full);
      if (stats.isDirectory() && stats.mtimeMs < cutoff) {
        fs.rmSync(full, { recursive: true, force: true });
      }
    }
  } catch {
    // Best effort.
  }
}
