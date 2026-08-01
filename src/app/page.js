'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { transcribeVideo } from '@/lib/asr-engines';
import {
  AlertTriangle,
  AudioWaveform,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock,
  Download,
  FastForward,
  FileJson,
  FileText,
  Film,
  Gauge,
  Languages,
  ListChecks,
  Maximize2,
  Menu,
  Pause,
  Play,
  Plus,
  Repeat,
  Rewind,
  RotateCcw,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';

const APP_NAME = 'LingoLoop';

const DEMO_CUES = [
  {
    id: 'cue-1',
    start: 2,
    end: 5.8,
    original: 'こんにちは、元気ですか？',
    translation: 'Hi, how are you?',
    reading: 'konnichiwa, genki desu ka',
    speaker: 'S1',
    confidence: 0.94,
  },
  {
    id: 'cue-2',
    start: 6.2,
    end: 10.4,
    original: '今日は新しい場所へ行きましょう。',
    translation: "Let's go somewhere new today.",
    reading: 'kyou wa atarashii basho e ikimashou',
    speaker: 'S1',
    confidence: 0.91,
  },
  {
    id: 'cue-3',
    start: 11,
    end: 15.2,
    original: '字幕を少し早く表示できますか？',
    translation: 'Can you show the subtitles a little earlier?',
    reading: 'jimaku o sukoshi hayaku hyouji dekimasu ka',
    speaker: 'S2',
    confidence: 0.82,
  },
  {
    id: 'cue-4',
    start: 16,
    end: 20,
    original: 'はい、タイミングを調整します。',
    translation: 'Yes, I will adjust the timing.',
    reading: 'hai, taimingu o chousei shimasu',
    speaker: 'S1',
    confidence: 0.96,
  },
];

const SAMPLE_MEDIA_PATH = 'sample.mp4';
const SAMPLE_MEDIA_URL = '/samples/sample.mp4';
const SAMPLE_FALLBACK_CUES = [
  {
    id: 'sample-fallback-1',
    start: 0.4,
    end: 4.2,
    original: 'Ask not what your country can do for you.',
    translation: '国があなたのために何をしてくれるかを問うのではありません。',
    reading: 'ask not what your country can do for you',
    confidence: 0.92,
  },
  {
    id: 'sample-fallback-2',
    start: 4.4,
    end: 8.8,
    original: 'Ask what you can do for your country.',
    translation: 'あなたが国のために何ができるかを問いましょう。',
    reading: 'ask what you can do for your country',
    confidence: 0.92,
  },
];

// Concrete languages (used for target selection and label lookups).
const languages = [
  { value: 'ja', label: 'Japanese' },
  { value: 'en', label: 'English' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ko', label: 'Korean' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
];

const TRANSLATION_TIMEOUT_MS = 60_000;
const TRANSLATION_MAX_ATTEMPTS = 3;
const TRANSLATION_RECOVERY_DELAY_MS = 1800;

// Source selection: NO passthrough "auto" default. Either a real language is
// chosen, or "Auto-detect" which runs actual language recognition, or "None"
// which forces the user to make a choice before transcribing.
const sourceLanguages = [
  { value: 'detect', label: 'Auto-detect (recognition)' },
  { value: 'none', label: 'None — pick a language' },
  ...languages,
];

function sourceLangLabel(value) {
  return sourceLanguages.find((item) => item.value === value)?.label || value;
}

function languageLabel(value) {
  return languages.find((item) => item.value === value)?.label || value;
}

const sourceModes = [
  { id: 'embedded', label: 'Embedded', detail: 'Extract existing subtitle tracks' },
  { id: 'sidecar', label: 'Sidecar', detail: 'Parse SRT, VTT, ASS' },
  { id: 'transcribe', label: 'Transcribe', detail: 'Local server-side Whisper path' },
];

const TRANSCRIPTION_STAGE_DEFINITIONS = [
  { id: 'source', label: 'Read selected media', detail: 'Keep the imported MP4 attached to this transcription job.' },
  { id: 'preflight', label: 'Check engine readiness', detail: 'Verify FFmpeg, ffprobe, the local recognizer, and the selected model.' },
  { id: 'transfer', label: 'Send the actual MP4', detail: 'Use the Electron file path or upload the browser File to the local route.' },
  { id: 'native', label: 'Create source-language cues', detail: 'ffprobe -> FFmpeg mono 16 kHz WAV -> local Whisper.' },
  { id: 'cues', label: 'Parse timestamps', detail: 'Convert local Whisper segments into timed subtitle cues.' },
  { id: 'translation', label: 'Translate cue text', detail: 'Translate each real source cue into the selected target language.' },
  { id: 'render', label: 'Open the subtitle viewer', detail: 'Render only the cues created for this imported file.' },
];

const qualityPresets = {
  fast: {
    label: 'Fast',
    detail: 'Whisper Tiny, VAD trim, minimal cleanup',
    cleanup: { separateVocals: false, denoise: false, diarize: false, mixedLanguage: false },
  },
  balanced: {
    label: 'Balanced',
    detail: 'Whisper Base, denoise + loudnorm',
    cleanup: { separateVocals: false, denoise: true, diarize: false, mixedLanguage: true },
  },
  best: {
    label: 'Best',
    detail: 'Whisper Small, full cleanup + diarization',
    cleanup: { separateVocals: true, denoise: true, diarize: true, mixedLanguage: true },
  },
};

const cleanupOptions = [
  { id: 'separateVocals', label: 'Vocal isolation', detail: 'Demucs/Spleeter path for music-heavy videos' },
  { id: 'denoise', label: 'Denoise', detail: 'RNNoise/DeepFilterNet-style cleanup' },
  { id: 'diarize', label: 'Diarize', detail: 'Speaker turns for interviews/classes' },
  { id: 'mixedLanguage', label: 'Mixed language', detail: 'Detect source language per segment' },
];

const exportFormats = [
  { id: 'srt', label: 'Dual SRT', detail: 'Two-line soft subtitles' },
  { id: 'ass', label: 'Styled ASS', detail: 'Burn-in ready script' },
  { id: 'json', label: 'Project JSON', detail: 'Cue + queue metadata' },
  { id: 'report', label: 'Batch report', detail: 'CSV job summary' },
];

const subtitleStyles = [
  { id: 'cinema', label: 'Cinema' },
  { id: 'boxed', label: 'Box' },
  { id: 'minimal', label: 'Minimal' },
];

const subtitlePositions = [
  { id: 'bottom', label: 'Bottom' },
  { id: 'middle', label: 'Middle' },
  { id: 'top', label: 'Top' },
];

const subtitleMaskModes = [
  { id: 'off', label: 'Off', detail: 'No existing subtitle cover' },
  { id: 'hide', label: 'Hide soft', detail: 'Skip selectable original tracks' },
  { id: 'box', label: 'Cover box', detail: 'Dark band for burned-in text' },
  { id: 'blur', label: 'Blur', detail: 'Delogo-style soft cover' },
];

const maskPresets = [
  { id: 'bottom', label: 'Bottom band', rect: { x: 0, y: 0.78, w: 1, h: 0.2 } },
  { id: 'safe', label: 'Subtitle safe', rect: { x: 0.08, y: 0.72, w: 0.84, h: 0.18 } },
  { id: 'top', label: 'Top band', rect: { x: 0, y: 0.06, w: 1, h: 0.16 } },
];

const settingsTabs = [
  { id: 'languages', label: 'Languages' },
  { id: 'subtitles', label: 'Subtitles' },
  { id: 'audio', label: 'Audio & Recognition' },
  { id: 'learning', label: 'Learning' },
  { id: 'export', label: 'Export' },
  { id: 'batch', label: 'Batch' },
  { id: 'advanced', label: 'Advanced' },
];

const studyFeatures = [
  { label: 'Loop mining', detail: 'Replay a cue, shadow it, then save it as a review card.' },
  { label: 'FSRS review', detail: 'Built-in spaced repetition keeps mined lines inside LingoLoop.' },
  { label: 'Frame OCR', detail: 'Translate signs, captions, and hardcoded text sampled from the picture.' },
  { label: 'Pronunciation scorer', detail: 'Record yourself and compare timing against the native line.' },
  { label: 'Grammar explain', detail: 'Ask for POS, particles, literal gloss, idiom, or slang notes.' },
  { label: 'Auto quizzes', detail: 'Generate cloze, dictation, and multiple-choice drills per scene.' },
];

const loopTools = [
  { label: 'Loop line', detail: 'A-B repeat the active subtitle.' },
  { label: 'Shadow', detail: 'Record and compare your timing.' },
  { label: 'Mine card', detail: 'Save line + screenshot to FSRS.' },
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function normalizeMaskRect(rect) {
  const w = clamp(rect.w, 0.12, 1);
  const h = clamp(rect.h, 0.08, 0.5);
  return {
    x: clamp(rect.x, 0, 1 - w),
    y: clamp(rect.y, 0, 1 - h),
    w,
    h,
  };
}

function pct(value) {
  return `${Math.round(value * 100)}%`;
}

function makeMaskFilter({ mode, rect, opacity, blur }) {
  if (mode === 'off') return 'none';
  if (mode === 'hide') return 'soft original subtitle streams disabled';
  const x = rect.x.toFixed(3);
  const y = rect.y.toFixed(3);
  const w = rect.w.toFixed(3);
  const h = rect.h.toFixed(3);
  if (mode === 'blur') {
    return `delogo=x=iw*${x}:y=ih*${y}:w=iw*${w}:h=ih*${h},boxblur=${Math.round(blur)}:1`;
  }
  return `drawbox=x=iw*${x}:y=ih*${y}:w=iw*${w}:h=ih*${h}:color=black@${opacity.toFixed(2)}:t=fill`;
}

function secondsToClock(value) {
  const safe = Math.max(0, Number(value) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = Math.floor(safe % 60);
  const millis = Math.round((safe - Math.floor(safe)) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function secondsToSrt(value) {
  return secondsToClock(value).replace('.', ',');
}

// Compact clock for the transport bar (no milliseconds): 1:04:03 or 4:03.
function clockShort(value) {
  const total = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// ---- "Continue watching" memory ------------------------------------------
// Positions are stored per video (name + size), NOT the video itself — the
// media file stays wherever it lives on disk and is never copied.
const POSITIONS_KEY = 'lingoloop.playback-positions';

function loadPositions() {
  if (typeof window === 'undefined') return {};
  try {
    return JSON.parse(window.localStorage.getItem(POSITIONS_KEY)) || {};
  } catch {
    return {};
  }
}

function savePlaybackPosition(key, time, duration) {
  if (!key || typeof window === 'undefined') return;
  try {
    const all = loadPositions();
    // Near the start or the end -> forget the position (like VLC does).
    if (time < 5 || (duration && time > duration - 10)) {
      delete all[key];
    } else {
      all[key] = { t: Math.floor(time), d: Math.floor(duration || 0), at: Date.now() };
    }
    // Cap the list so this never becomes its own cache problem.
    const trimmed = Object.fromEntries(
      Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 200),
    );
    window.localStorage.setItem(POSITIONS_KEY, JSON.stringify(trimmed));
  } catch {
    // localStorage full/unavailable — not worth interrupting playback.
  }
}

const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2];
const SUBTITLE_LOG_KEY = 'lingoloop.session-subtitle-log';
const SUBTITLE_COLOR_PRESETS = ['#ffffff', '#f8d86a', '#8be9fd', '#a7f3d0'];

function secondsToAss(value) {
  const safe = Math.max(0, Number(value) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = Math.floor(safe % 60);
  const centiseconds = Math.floor((safe - Math.floor(safe)) * 100);
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
}

function parseTimestamp(value) {
  const match = value.trim().match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/);
  if (!match) return 0;
  const [, rawHours = '0', rawMinutes, rawSeconds, rawMillis] = match;
  return (Number(rawHours) * 3600) + (Number(rawMinutes) * 60) + Number(rawSeconds) + Number(rawMillis.padEnd(3, '0').slice(0, 3)) / 1000;
}

function stripTags(text) {
  return text
    .replace(/\{\\[^}]+}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[[^\]]+]/g, '')
    .trim();
}

function wordsFromText(text) {
  const tokens = text
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length > 0) {
    return tokens.slice(0, 18).map((token, index) => ({
      text: token,
      reading: token.toLowerCase(),
      freq: index % 5 === 0 ? 'study' : index % 4 === 0 ? 'advanced' : 'core',
    }));
  }

  return Array.from(text.replace(/\s+/g, '').slice(0, 12)).map((token, index) => ({
    text: token,
    reading: token,
    freq: index % 3 === 0 ? 'study' : 'core',
  }));
}

function enrichCue(cue, index) {
  const original = stripTags(cue.original || '');
  return {
    id: cue.id || `cue-${index + 1}`,
    start: Number(cue.start) || 0,
    end: Number(cue.end) || (Number(cue.start) || 0) + 3,
    original,
    translation: stripTags(cue.translation || original),
    translationError: cue.translationError || null,
    reading: cue.reading || wordsFromText(original).map((word) => word.reading).join(' '),
    speaker: cue.speaker || `S${(index % 2) + 1}`,
    confidence: cue.confidence ?? 0.88,
    words: cue.words || wordsFromText(original),
  };
}

function normalizeCuesForPlayback(nextCues) {
  return nextCues
    .map(enrichCue)
    .filter((cue) => cue.original && Number.isFinite(cue.start) && Number.isFinite(cue.end))
    .map((cue) => ({ ...cue, end: Math.max(cue.start + 0.08, cue.end) }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function cueAtTime(cues, time) {
  let low = 0;
  let high = cues.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const cue = cues[middle];
    if (time < cue.start) high = middle - 1;
    else if (time >= cue.end) low = middle + 1;
    else return cue;
  }
  return null;
}

function parseSrt(text) {
  return text
    .replace(/\r/g, '')
    .split(/\n\s*\n/)
    .map((block, index) => {
      const lines = block.split('\n').filter(Boolean);
      const timingIndex = lines.findIndex((line) => line.includes('-->'));
      if (timingIndex === -1) return null;
      const [startRaw, endRaw] = lines[timingIndex].split('-->').map((part) => part.trim());
      return enrichCue({
        id: `sidecar-${index + 1}`,
        start: parseTimestamp(startRaw),
        end: parseTimestamp(endRaw),
        original: lines.slice(timingIndex + 1).join(' '),
      }, index);
    })
    .filter(Boolean);
}

function parseVtt(text) {
  return parseSrt(text.replace(/^WEBVTT[^\n]*\n/i, ''));
}

function parseAss(text) {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => line.startsWith('Dialogue:'))
    .map((line, index) => {
      const parts = line.slice('Dialogue:'.length).split(',');
      return enrichCue({
        id: `ass-${index + 1}`,
        start: parseTimestamp(parts[1] || '0:00:00.00'),
        end: parseTimestamp(parts[2] || '0:00:03.00'),
        original: parts.slice(9).join(',').replace(/\\N/g, ' '),
      }, index);
    });
}

function parseSubtitleFile(name, text) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.vtt')) return parseVtt(text);
  if (lower.endsWith('.ass') || lower.endsWith('.ssa')) return parseAss(text);
  return parseSrt(text);
}

function makeSrt(cues) {
  return cues.map((cue, index) => [
    String(index + 1),
    `${secondsToSrt(cue.start)} --> ${secondsToSrt(cue.end)}`,
    cue.original,
    cue.translation,
  ].join('\n')).join('\n\n');
}

function createTemporarySubtitleLog(name, cues, sourceMode) {
  return {
    name,
    sourceMode,
    createdAt: Date.now(),
    cueCount: cues.length,
    duration: cues[cues.length - 1]?.end || 0,
    srt: makeSrt(cues),
  };
}

function saveTemporarySubtitleLog(log) {
  if (typeof window === 'undefined') return;
  try {
    if (log) window.sessionStorage.setItem(SUBTITLE_LOG_KEY, JSON.stringify(log));
    else window.sessionStorage.removeItem(SUBTITLE_LOG_KEY);
  } catch {
    // Session storage is a convenience; subtitle playback must not depend on it.
  }
}

function hexToAssColor(value) {
  const normalized = String(value || '#ffffff').replace('#', '').padEnd(6, 'f').slice(0, 6);
  const red = normalized.slice(0, 2);
  const green = normalized.slice(2, 4);
  const blue = normalized.slice(4, 6);
  return `&H00${blue}${green}${red}`.toUpperCase();
}

function makeAss(cues, colors = {}) {
  const originalColor = hexToAssColor(colors.original);
  const translationColor = hexToAssColor(colors.translation);
  const header = [
    '[Script Info]',
    'Title: dual-live-translations export',
    'ScriptType: v4.00+',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Original,Arial,42,${originalColor},&H000000FF,&H00111111,&H66000000,-1,0,0,0,100,100,0,0,1,2,0,2,40,40,92,1`,
    `Style: Translation,Arial,34,${translationColor},&H000000FF,&H00111111,&H66000000,-1,0,0,0,100,100,0,0,1,2,0,2,40,40,42,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  return [
    ...header,
    ...cues.flatMap((cue) => [
      `Dialogue: 0,${secondsToAss(cue.start)},${secondsToAss(cue.end)},Original,,0,0,0,,${cue.original}`,
      `Dialogue: 0,${secondsToAss(cue.start)},${secondsToAss(cue.end)},Translation,,0,0,0,,${cue.translation}`,
    ]),
  ].join('\n');
}

function makeBatchReport(queue) {
  const header = 'input,status,progress,quality,targets,output';
  const rows = queue.map((job) => [
    job.input,
    job.status,
    `${job.progress}%`,
    job.quality,
    job.targets.join(';'),
    job.output.join(';'),
  ].map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(','));
  return [header, ...rows].join('\n');
}

function downloadText(filename, content, mime = 'text/plain') {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function getDesktopFilePath(file) {
  if (!file) return '';
  if (file.path) return file.path;
  try {
    if (typeof window !== 'undefined' && typeof window.require === 'function') {
      const { webUtils } = window.require('electron');
      return webUtils?.getPathForFile?.(file) || '';
    }
  } catch {
    return '';
  }
  return '';
}

function fileSizeLabel(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function createTranscriptionTrace(file, mediaPath) {
  const fileDetail = file
    ? `${file.name}${fileSizeLabel(file.size) ? ` · ${fileSizeLabel(file.size)}` : ''} · ${mediaPath ? 'desktop file path' : 'browser upload'}`
    : 'No media file is attached.';

  return TRANSCRIPTION_STAGE_DEFINITIONS.map((stage) => ({
    ...stage,
    status: stage.id === 'source' ? 'done' : 'queued',
    detail: stage.id === 'source' ? fileDetail : stage.detail,
  }));
}

function missingTranscriptionChecks(status) {
  const checks = status?.checks;
  if (!checks || typeof checks !== 'object') return ['transcription status'];
  return Object.entries(checks).filter(([, ready]) => !ready).map(([name]) => name);
}

function countTranslationFailures(list) {
  return list.filter((cue) => cue.translationError).length;
}

function csvRows(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter((line) => line.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((header) => header.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',').map((cell) => cell.trim().replace(/^"|"$/g, ''));
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] || '']));
  });
}

function makeQueueItem(input, index, defaults = {}) {
  const targets = Array.isArray(defaults.targets)
    ? defaults.targets
    : String(defaults.targets || 'en').split(/[;|]/).filter(Boolean);
  const quality = qualityPresets[defaults.quality] ? defaults.quality : 'balanced';
  const preset = qualityPresets[quality];

  return {
    id: `job-${Date.now()}-${index}`,
    input,
    status: 'queued',
    progress: 0,
    stage: 'waiting',
    priority: false,
    sourceLang: defaults.sourceLang || 'detect',
    targets: targets.length ? targets : ['en'],
    quality,
    cleanup: defaults.cleanup || preset.cleanup,
    output: Array.isArray(defaults.output)
      ? defaults.output
      : String(defaults.output || 'srt-dual;ass-dual').split(/[;|]/).filter(Boolean),
  };
}

function parseBatchManifest(name, text) {
  const lower = name.toLowerCase();

  if (lower.endsWith('.json')) {
    const parsed = JSON.parse(text);
    const defaults = parsed.defaults || {};
    const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
    return jobs.map((job, index) => makeQueueItem(job.input || job.path || `job-${index + 1}`, index, { ...defaults, ...job }));
  }

  if (lower.endsWith('.csv')) {
    return csvRows(text).map((row, index) => makeQueueItem(row.input || row.path || `row-${index + 1}`, index, row));
  }

  return text
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => makeQueueItem(line, index));
}

function IconButton({ label, icon: Icon, active, disabled = false, onClick, tooltip = false }) {
  return (
    <button
      type="button"
      className={`icon-button${active ? ' active' : ''}${tooltip ? ' tooltip-control' : ''}`}
      aria-label={label}
      title={tooltip ? undefined : label}
      data-tooltip={tooltip ? label : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={18} strokeWidth={2} />
    </button>
  );
}

function SelectControl({ label, value, onChange, options = languages, disabled = false }) {
  const selectedLabel = options.find((option) => option.value === value)?.label || value;

  return (
    <label className={`select-control${disabled ? ' disabled' : ''}`}>
      <span className="select-control-label">{label}</span>
      <span className="select-control-value" aria-hidden="true">{selectedLabel}</span>
      <select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {options.map((language) => (
          <option key={language.value} value={language.value}>{language.label}</option>
        ))}
      </select>
      <ChevronDown size={16} aria-hidden="true" />
    </label>
  );
}

function LanguageChangeDialog({ change, cueCount, onCancel, onConfirm }) {
  if (!change) return null;

  const sourceChange = change.kind === 'source';
  const previousLabel = sourceChange
    ? sourceLangLabel(change.previousValue)
    : languageLabel(change.previousValue);
  const nextLabel = sourceChange
    ? sourceLangLabel(change.nextValue)
    : languageLabel(change.nextValue);

  return (
    <div className="confirmation-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        className="confirmation-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="language-change-title"
        aria-describedby="language-change-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="confirmation-icon" aria-hidden="true"><AlertTriangle size={24} /></div>
        <div className="confirmation-copy">
          <h2 id="language-change-title">
            {sourceChange ? 'Regenerate subtitles from the audio?' : 'Translate subtitles again?'}
          </h2>
          <p id="language-change-description">
            {sourceChange
              ? `Changing the source language from ${previousLabel} to ${nextLabel} will discard the current subtitle result and run speech recognition and translation again.`
              : `Changing the target language from ${previousLabel} to ${nextLabel} will translate all ${cueCount} existing subtitle cues again. The source text and timing will stay unchanged.`}
          </p>
          <div className="confirmation-summary">
            <span>{previousLabel}</span>
            <strong aria-hidden="true">→</strong>
            <span>{nextLabel}</span>
          </div>
          <p className="confirmation-note">
            The video will remain paused and progress will be shown while subtitles are regenerated.
          </p>
        </div>
        <div className="confirmation-actions">
          <button type="button" className="secondary-action" onClick={onCancel}>Keep current subtitles</button>
          <button type="button" className="primary-action" onClick={onConfirm}>
            {sourceChange ? 'Regenerate subtitles' : 'Translate again'}
          </button>
        </div>
      </section>
    </div>
  );
}

function RegenerateDialog({ request, item, busy, onChange, onCancel, onConfirm }) {
  if (!request || !item) return null;

  const hasExistingSubtitles = Boolean(item.cues?.length);
  const dialogTitle = hasExistingSubtitles ? 'Regenerate subtitles' : 'Create subtitles';
  const lastDetection = item.detectedLang ? sourceLangLabel(item.detectedLang) : null;

  return (
    <div className="confirmation-backdrop" role="presentation" onMouseDown={busy ? undefined : onCancel}>
      <section
        className="confirmation-dialog regeneration-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="regeneration-title"
        aria-describedby="regeneration-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="confirmation-icon regeneration-icon" aria-hidden="true"><RotateCcw size={24} /></div>
        <div className="confirmation-copy">
          <h2 id="regeneration-title">{dialogTitle}</h2>
          <p id="regeneration-description">
            {hasExistingSubtitles ? 'Run speech recognition again from the beginning for ' : 'Run speech recognition from the beginning for '}
            <strong>{item.name}</strong>, then translate every new cue.
            {hasExistingSubtitles ? ' The current subtitles will only be replaced after the new run succeeds.' : ''}
          </p>
          <div className="regeneration-fields">
            <SelectControl
              label="Spoken language"
              value={request.sourceLanguage}
              onChange={(value) => onChange({ sourceLanguage: value })}
              options={sourceLanguages.filter((language) => language.value !== 'none')}
              disabled={busy}
            />
            <SelectControl
              label="Translate to"
              value={request.targetLanguage}
              onChange={(value) => onChange({ targetLanguage: value })}
              disabled={busy}
            />
          </div>
          <p className="confirmation-note regeneration-note">
            {request.sourceLanguage === 'detect'
              ? `Auto-detect will inspect the audio again.${lastDetection ? ` The previous run detected ${lastDetection}; choose the actual language above if that was wrong.` : ''}`
              : `Speech recognition will be forced to ${sourceLangLabel(request.sourceLanguage)} instead of auto-detecting.`}
          </p>
        </div>
        <div className="confirmation-actions">
          <button type="button" className="secondary-action" disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="button" className="primary-action" disabled={busy} onClick={onConfirm}>
            <RotateCcw size={16} />
            {busy ? 'Starting…' : hasExistingSubtitles ? 'Regenerate from audio' : 'Create subtitles'}
          </button>
        </div>
      </section>
    </div>
  );
}

function StatusDot({ status }) {
  if (status === 'done') return <CheckCircle2 size={17} className="status-done" />;
  if (status === 'running') return <Clock size={17} className="status-running" />;
  if (status === 'failed') return <X size={17} className="status-error" />;
  return <Circle size={17} className="status-queued" />;
}

function PipelineStep({ job }) {
  return (
    <div className={`pipeline-step ${job.status}`}>
      <StatusDot status={job.status} />
      <div>
        <strong>{job.label}</strong>
        <span>{job.detail}</span>
      </div>
      <small>{job.progress}%</small>
    </div>
  );
}

function WordChip({ word, selected, onClick }) {
  return (
    <button type="button" className={`word-chip ${word.freq}${selected ? ' selected' : ''}`} onClick={onClick}>
      <span>{word.text}</span>
      <small>{word.reading}</small>
    </button>
  );
}

function buildJobs(sourceMode, cues, translationDone, translationRunning, queueRunning) {
  const translationStatus = translationDone
    ? { detail: 'translations ready', status: 'done', progress: 100 }
    : translationRunning
      ? { detail: 'request in progress', status: 'running', progress: 70 }
      : cues.length
        ? { detail: 'retry required', status: 'failed', progress: 70 }
        : { detail: 'waiting for cues', status: 'queued', progress: 0 };
  return [
    { id: 'probe', label: 'Probe media', detail: 'ffprobe stream plan', status: 'done', progress: 100 },
    { id: 'audio', label: 'Clean audio', detail: 'quality preset chain', status: queueRunning ? 'running' : 'done', progress: queueRunning ? 72 : 100 },
    { id: 'base', label: 'Acquire cues', detail: sourceModes.find((item) => item.id === sourceMode)?.detail || 'subtitle source', status: cues.length ? 'done' : 'queued', progress: cues.length ? 100 : 0 },
    { id: 'translate', label: 'Batch translate', ...translationStatus },
    { id: 'export', label: 'Export files', detail: 'SRT, ASS, batch report', status: 'done', progress: 100 },
  ];
}

export default function Home() {
  const mediaInputRef = useRef(null);
  const sidecarInputRef = useRef(null);
  const batchInputRef = useRef(null);
  const videoRef = useRef(null);
  const videoFrameRef = useRef(null);
  const simulationRef = useRef(null);
  const maskDragRef = useRef(null);
  const controlsTimerRef = useRef(null);
  const mediaFileRef = useRef(null);
  const processingCancelRef = useRef(false);
  const activeItemIdRef = useRef(null);
  const libraryRef = useRef([]);
  const [viewStep, setViewStep] = useState('landing');
  const [intent] = useState('watch');
  const [library, setLibrary] = useState([]);
  const [activeItemId, setActiveItemId] = useState(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState('subtitles');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [mode, setMode] = useState('education');
  const [sourceLang, setSourceLang] = useState('detect');
  const [detectedLang, setDetectedLang] = useState(null);
  const [transcribing, setTranscribing] = useState(false);
  const [transcriptionStatus, setTranscriptionStatus] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [processingKind, setProcessingKind] = useState('full');
  const [processingStage, setProcessingStage] = useState('');
  const [processingProgress, setProcessingProgress] = useState(0);
  const [activeEngine, setActiveEngine] = useState(null);
  const [targetLang, setTargetLang] = useState('en');
  const [pendingLanguageChange, setPendingLanguageChange] = useState(null);
  const [regenerationRequest, setRegenerationRequest] = useState(null);
  const [regenerationRunning, setRegenerationRunning] = useState(false);
  const [sourceMode, setSourceMode] = useState('transcribe');
  const [subtitleOrigin, setSubtitleOrigin] = useState('demo');
  const [transcriptionTrace, setTranscriptionTrace] = useState([]);
  const [transcriptionDebug, setTranscriptionDebug] = useState(null);
  const [quality, setQuality] = useState('balanced');
  const [cleanup, setCleanup] = useState(qualityPresets.balanced.cleanup);
  const [subtitleStyle, setSubtitleStyle] = useState('minimal');
  const [subtitlePosition, setSubtitlePosition] = useState('bottom');
  const [subtitleOriginalColor, setSubtitleOriginalColor] = useState('#ffffff');
  const [subtitleTranslationColor, setSubtitleTranslationColor] = useState('#ffffff');
  const [subtitleLog, setSubtitleLog] = useState(null);
  const [maskMode, setMaskMode] = useState('off');
  const [maskRect, setMaskRect] = useState(() => maskPresets[0].rect);
  const [maskOpacity, setMaskOpacity] = useState(0.78);
  const [maskBlur, setMaskBlur] = useState(8);
  const [maskFeather, setMaskFeather] = useState(10);
  const [maskEditing, setMaskEditing] = useState(false);
  const [focusView] = useState(false);
  const [panelTab, setPanelTab] = useState('queue');
  const [muted, setMuted] = useState(false);
  const [batchSize, setBatchSize] = useState(50);
  const [concurrency, setConcurrency] = useState(3);
  const [cacheEnabled, setCacheEnabled] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const timelineRef = useRef(null);
  const positionSaveRef = useRef(0);
  const playbackSyncFrameRef = useRef(null);
  const playbackSyncTickRef = useRef(0);
  const [selectedWord, setSelectedWord] = useState(null);
  const [mediaName, setMediaName] = useState('demo-media.mp4');
  const [mediaUrl, setMediaUrl] = useState('');
  const [mediaPath, setMediaPath] = useState('');
  const [sidecarName, setSidecarName] = useState('');
  const [cues, setCues] = useState(() => DEMO_CUES.map(enrichCue));
  const [savedCards, setSavedCards] = useState([]);
  const [formats, setFormats] = useState({ srt: true, ass: true, json: false, report: true });
  const [statusMessage, setStatusMessage] = useState('Ready. Import media, sidecar subtitles, or a batch manifest.');
  const [translationDone, setTranslationDone] = useState(true);
  const [translationRunning, setTranslationRunning] = useState(false);
  const [queue, setQueue] = useState(() => [
    makeQueueItem('/videos/lecture01.mp4', 0, { quality: 'balanced', output: ['srt-dual', 'ass-dual'] }),
    makeQueueItem('/videos/interview.mkv', 1, { quality: 'best', targets: ['en', 'zh'], cleanup: qualityPresets.best.cleanup }),
  ]);
  const [queueRunning, setQueueRunning] = useState(false);
  const [manifestSummary, setManifestSummary] = useState('2 demo jobs loaded');

  const activeCue = useMemo(() => cueAtTime(cues, playbackTime), [cues, playbackTime]);
  const jobs = useMemo(
    () => buildJobs(sourceMode, cues, translationDone, translationRunning, queueRunning),
    [sourceMode, cues, translationDone, translationRunning, queueRunning],
  );
  const completeCount = jobs.filter((job) => job.status === 'done').length;
  const runningJob = jobs.find((job) => job.status === 'running') ?? jobs[jobs.length - 1];
  const overallProgress = Math.round(jobs.reduce((total, job) => total + job.progress, 0) / jobs.length);
  const vocabulary = useMemo(() => cues.flatMap((cue) => cue.words), [cues]);
  const currentWord = selectedWord ?? vocabulary[0];
  const maskSettings = useMemo(() => ({
    mode: maskMode,
    rect: maskRect,
    opacity: maskOpacity,
    blur: maskBlur,
    feather: maskFeather,
    exportFilter: makeMaskFilter({ mode: maskMode, rect: maskRect, opacity: maskOpacity, blur: maskBlur }),
  }), [maskBlur, maskFeather, maskMode, maskOpacity, maskRect]);
  const queueStats = useMemo(() => {
    const done = queue.filter((job) => job.status === 'done').length;
    const running = queue.filter((job) => job.status === 'running').length;
    const queued = queue.filter((job) => job.status === 'queued').length;
    const overall = queue.length ? Math.round(queue.reduce((sum, job) => sum + job.progress, 0) / queue.length) : 0;
    return { done, running, queued, overall };
  }, [queue]);
  const dueCards = savedCards.filter((card) => card.fsrs.due <= Date.now()).length;
  const whisperReady = Boolean(transcriptionStatus?.ready);
  const playbackReady = Boolean(
    cues.length
    && translationDone
    && subtitleOrigin !== 'unprocessed'
    && !transcribing
    && !processing,
  );
  const pendingCount = useMemo(
    () => library.filter((item) => !item.cues?.length && item.status !== 'processing').length,
    [library],
  );

  const refreshTranscriptionStatus = useCallback(async (nextQuality = quality) => {
    try {
      const response = await fetch(`/api/transcribe?quality=${encodeURIComponent(nextQuality)}`);
      if (response.ok) {
        const data = await response.json();
        if (data && typeof data === 'object') {
          setTranscriptionStatus(data);
          return data;
        }
      }
    } catch {
      // Fall through to the shared unavailable state below.
    }
    const unavailable = { ready: false, checks: {}, paths: {} };
    setTranscriptionStatus(unavailable);
    return unavailable;
  }, [quality]);

  const updateTranscriptionTrace = (id, status, detail) => {
    setTranscriptionTrace((current) => current.map((stage) => (
      stage.id === id ? { ...stage, status, detail: detail || stage.detail } : stage
    )));
  };

  useEffect(() => () => {
    if (simulationRef.current) window.clearInterval(simulationRef.current);
    if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current);
    if (playbackSyncFrameRef.current) window.cancelAnimationFrame(playbackSyncFrameRef.current);
  }, []);

  useEffect(() => {
    try {
      const savedLog = JSON.parse(window.sessionStorage.getItem(SUBTITLE_LOG_KEY));
      if (savedLog?.srt && Number.isFinite(savedLog.cueCount)) setSubtitleLog(savedLog);
    } catch {
      // A malformed session log should never affect the player.
    }
  }, []);

  // Object URLs are owned by library items (they must stay alive so the user
  // can switch videos at any time). Revoke them all when the app unmounts.
  useEffect(() => {
    libraryRef.current = library;
  }, [library]);
  useEffect(() => () => {
    libraryRef.current.forEach((item) => {
      if (item.url) URL.revokeObjectURL(item.url);
    });
  }, []);

  useEffect(() => {
    refreshTranscriptionStatus(quality);
  }, [quality, refreshTranscriptionStatus]);

  useEffect(() => {
    if (!queueRunning) return undefined;

    const interval = window.setInterval(() => {
      setQueue((current) => {
        const maxActive = Math.max(1, Math.min(12, Number(concurrency) || 2));
        const sorted = [...current].sort((a, b) => Number(b.priority) - Number(a.priority));
        const activeIds = new Set(sorted.filter((job) => job.status === 'running').map((job) => job.id));
        for (const job of sorted) {
          if (activeIds.size >= maxActive) break;
          if (job.status === 'queued') activeIds.add(job.id);
        }

        return current.map((job) => {
          if (!activeIds.has(job.id) || job.status === 'done') return job;
          const nextProgress = Math.min(100, job.progress + (job.quality === 'best' ? 6 : job.quality === 'fast' ? 14 : 10));
          return {
            ...job,
            status: nextProgress >= 100 ? 'done' : 'running',
            progress: nextProgress,
            stage: nextProgress < 35 ? 'cleaning audio' : nextProgress < 70 ? 'transcribing' : nextProgress < 100 ? 'batch translating' : 'exported',
          };
        });
      });
    }, 850);

    return () => window.clearInterval(interval);
  }, [concurrency, queueRunning]);

  useEffect(() => {
    if (!queueRunning || !queue.length) return;
    if (queue.every((job) => job.status === 'done')) {
      setQueueRunning(false);
      setStatusMessage('Offline batch queue complete. Subtitle files and batch reports are ready.');
    }
  }, [queue, queueRunning]);

  useEffect(() => {
    if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current);
    if (viewStep !== 'player' || !isPlaying || settingsOpen) {
      setControlsVisible(true);
      return undefined;
    }

    setControlsVisible(true);
    controlsTimerRef.current = window.setTimeout(() => setControlsVisible(false), 2200);
    return () => {
      if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current);
    };
  }, [isPlaying, settingsOpen, viewStep]);

  useEffect(() => {
    if (!maskEditing) return undefined;

    const handleMove = (event) => {
      const drag = maskDragRef.current;
      if (!drag) return;
      const dx = (event.clientX - drag.startX) / drag.frameWidth;
      const dy = (event.clientY - drag.startY) / drag.frameHeight;
      setMaskRect(normalizeMaskRect({
        ...drag.rect,
        x: drag.rect.x + dx,
        y: drag.rect.y + dy,
      }));
    };

    const handleUp = () => {
      maskDragRef.current = null;
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [maskEditing]);

  // Keep the chosen speed when a new video loads.
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = playbackRate;
  }, [playbackRate, mediaUrl]);

  // Media `timeupdate` can be as sparse as four events per second. A lightly
  // throttled animation-frame sync keeps subtitle boundaries aligned without
  // re-rendering the full workspace on every video frame.
  useEffect(() => {
    if (!isPlaying || !mediaUrl || !videoRef.current) return undefined;
    const sync = (timestamp) => {
      const video = videoRef.current;
      if (!video || video.paused) return;
      if (timestamp - playbackSyncTickRef.current >= 80) {
        playbackSyncTickRef.current = timestamp;
        const currentTime = video.currentTime;
        setPlaybackTime((current) => Math.abs(current - currentTime) >= 0.03 ? currentTime : current);
      }
      playbackSyncFrameRef.current = window.requestAnimationFrame(sync);
    };
    playbackSyncFrameRef.current = window.requestAnimationFrame(sync);
    return () => {
      if (playbackSyncFrameRef.current) window.cancelAnimationFrame(playbackSyncFrameRef.current);
      playbackSyncFrameRef.current = null;
    };
  }, [isPlaying, mediaUrl]);

  // VLC-style keyboard shortcuts (player view only, not while typing).
  useEffect(() => {
    if (viewStep !== 'player') return undefined;
    const handleKey = (event) => {
      if (settingsOpen || libraryOpen || processing) return;
      const target = event.target;
      if (target instanceof HTMLElement && (
        target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.isContentEditable
      )) return;

      switch (event.key) {
        case ' ':
        case 'k':
          event.preventDefault();
          togglePlayback();
          break;
        case 'ArrowRight':
          event.preventDefault();
          seekBy(10);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          seekBy(-10);
          break;
        case 'ArrowUp':
          if (videoRef.current) {
            event.preventDefault();
            videoRef.current.volume = clamp(videoRef.current.volume + 0.1, 0, 1);
          }
          break;
        case 'ArrowDown':
          if (videoRef.current) {
            event.preventDefault();
            videoRef.current.volume = clamp(videoRef.current.volume - 0.1, 0, 1);
          }
          break;
        case 'm':
          toggleMute();
          break;
        case 'f':
          toggleFullscreen();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  });

  const recordSubtitleLog = (normalizedCues, nextSourceMode, nextName = mediaName) => {
    const log = createTemporarySubtitleLog(nextName, normalizedCues, nextSourceMode);
    setSubtitleLog(log);
    saveTemporarySubtitleLog(log);
  };

  const clearSubtitleLog = () => {
    setSubtitleLog(null);
    saveTemporarySubtitleLog(null);
  };

  const downloadSubtitleLog = () => {
    if (!subtitleLog?.srt) return;
    const baseName = subtitleLog.name.replace(/\.[^.]+$/, '') || 'subtitle-log';
    downloadText(`${baseName}.session.srt`, subtitleLog.srt);
  };

  const applyCues = (nextCues, nextSourceMode, message, logName = mediaName) => {
    const enriched = normalizeCuesForPlayback(nextCues);
    const failedTranslations = countTranslationFailures(enriched);
    setCues(enriched);
    setSourceMode(nextSourceMode);
    setSubtitleOrigin(nextSourceMode === 'sidecar' ? 'sidecar' : nextSourceMode === 'transcribe' ? 'transcription' : 'unprocessed');
    setPlaybackTime(enriched[0]?.start ?? 0);
    setSelectedWord(enriched[0]?.words?.[0] ?? null);
    setTranslationDone(nextSourceMode !== 'sidecar' && enriched.length > 0 && failedTranslations === 0);
    setStatusMessage(failedTranslations
      ? `${message} ${failedTranslations} translation${failedTranslations === 1 ? '' : 's'} failed; use Re-translate to try again.`
      : message);
    if (nextSourceMode !== 'sidecar' && enriched.length && failedTranslations === 0) {
      recordSubtitleLog(enriched, nextSourceMode, logName);
    }
  };

  const handleQualityChange = (nextQuality) => {
    setQuality(nextQuality);
    setCleanup(qualityPresets[nextQuality].cleanup);
    setStatusMessage(`${qualityPresets[nextQuality].label} preset selected: ${qualityPresets[nextQuality].detail}.`);
  };

  const toggleCleanup = (id) => {
    setCleanup((current) => ({ ...current, [id]: !current[id] }));
  };

  const chooseMaskMode = (nextMode) => {
    setMaskMode(nextMode);
    setStatusMessage(subtitleMaskModes.find((item) => item.id === nextMode)?.detail || 'Subtitle mask updated.');
  };

  const applyMaskPreset = (preset) => {
    setMaskRect(normalizeMaskRect(preset.rect));
    setMaskEditing(true);
    if (maskMode === 'off' || maskMode === 'hide') setMaskMode('box');
    setStatusMessage(`${preset.label} mask region selected.`);
  };

  const updateMaskRect = (key, value) => {
    setMaskRect((current) => normalizeMaskRect({ ...current, [key]: Number(value) / 100 }));
  };

  const startMaskDrag = (event) => {
    if (!maskEditing || maskMode === 'off' || maskMode === 'hide') return;
    const frame = videoFrameRef.current?.getBoundingClientRect();
    if (!frame) return;
    maskDragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      frameWidth: frame.width || 1,
      frameHeight: frame.height || 1,
      rect: maskRect,
    };
    event.preventDefault();
  };

  const updateLibraryItem = (id, patch) => {
    setLibrary((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const removeLibraryItem = (item) => {
    if (!item) return;
    if (processing || batchRunning || item.status === 'processing') {
      setStatusMessage('Wait for subtitle processing to finish before removing videos from the library.');
      return;
    }
    if (!window.confirm(`Remove "${item.name}" from Your library?\n\nThe original file on your computer will not be deleted.`)) return;

    const current = libraryRef.current;
    const removedIndex = current.findIndex((entry) => entry.id === item.id);
    if (removedIndex < 0) return;
    const remaining = current.filter((entry) => entry.id !== item.id);
    libraryRef.current = remaining;
    setLibrary(remaining);

    if (activeItemIdRef.current === item.id) {
      videoRef.current?.pause();
      if (simulationRef.current) {
        window.clearInterval(simulationRef.current);
        simulationRef.current = null;
      }
      activeItemIdRef.current = null;
      setActiveItemId(null);
      mediaFileRef.current = null;
      setMediaUrl('');
      setMediaPath('');
      setIsPlaying(false);
      setDuration(0);
      setPlaybackTime(0);
      setCues([]);
      setSelectedWord(null);
      setSubtitleOrigin('unprocessed');
      setTranslationDone(false);
      setDetectedLang(null);
      clearSubtitleLog();

      const nextItem = remaining[Math.min(removedIndex, remaining.length - 1)];
      if (nextItem) {
        selectLibraryItem(nextItem);
      } else {
        setMediaName('No video selected');
        setSidecarName('');
        setTranscriptionTrace([]);
        setTranscriptionDebug(null);
        setViewStep('landing');
      }
    }

    if (item.url) {
      window.setTimeout(() => URL.revokeObjectURL(item.url), 0);
    }
    setStatusMessage(`Removed ${item.name} from Your library. The original file was not deleted.`);
  };

  // Make a library item the one showing in the player. Processed items open
  // straight into the viewer; unprocessed items go to the (short) config step.
  const selectLibraryItem = (item, options = {}) => {
    if (!item) return;
    videoRef.current?.pause();
    activeItemIdRef.current = item.id;
    setActiveItemId(item.id);
    mediaFileRef.current = item.file || null;
    setMediaUrl(item.url || '');
    setMediaName(item.name);
    setMediaPath(item.path || '');
    setDetectedLang(item.detectedLang || null);
    if (item.sourceLanguage) setSourceLang(item.sourceLanguage);
    if (item.translatedTo) setTargetLang(item.translatedTo);
    setIsPlaying(false);
    setDuration(0);
    setSelectedWord(null);
    setSourceMode('transcribe');
    if (item.cues?.length) {
      const normalizedCues = normalizeCuesForPlayback(item.cues);
      const translationsReady = countTranslationFailures(normalizedCues) === 0;
      setCues(normalizedCues);
      setPlaybackTime(normalizedCues[0]?.start ?? 0);
      setSubtitleOrigin('transcription');
      setTranslationDone(translationsReady);
      if (translationsReady) recordSubtitleLog(normalizedCues, 'transcribe', item.name);
      setViewStep('player');
      setStatusMessage(`Now showing ${item.name}. Press Play whenever you're ready.`);
    } else {
      setCues([]);
      setPlaybackTime(0);
      setSubtitleOrigin('unprocessed');
      setTranslationDone(false);
      clearSubtitleLog();
      setTranscriptionTrace(createTranscriptionTrace(item.file, item.path));
      setTranscriptionDebug(null);
      setViewStep(options.stay ? viewStep : 'config');
      setStatusMessage(`${item.name} doesn't have subtitles yet. Press "Create subtitles" to transcribe and translate it.`);
    }
  };

  // Accept one or many dropped/browsed media files into the library.
  const addFilesToLibrary = (fileList) => {
    const files = Array.from(fileList || []).filter((file) => (
      file.type?.startsWith('video/')
      || file.type?.startsWith('audio/')
      || /\.(mp4|mkv|mov|webm|m4v|mp3|wav|m4a|aac|flac|ogg)$/i.test(file.name)
    ));
    if (!files.length) {
      setStatusMessage('Those files were not recognized as video or audio.');
      return;
    }
    const items = files.map((file, index) => ({
      id: `media-${Date.now()}-${index}`,
      name: file.name,
      file,
      url: URL.createObjectURL(file),
      path: getDesktopFilePath(file),
      status: 'new',
      progress: 0,
      stage: '',
      cues: null,
      detectedLang: null,
      error: null,
    }));
    setLibrary((current) => [...current, ...items]);
    selectLibraryItem(items[0]);
    setStatusMessage(items.length === 1
      ? `Added ${items[0].name}. Check the languages below, then press "Create subtitles".`
      : `Added ${items.length} videos to your library. Transcribe them one by one, or all at once from the library menu.`);
  };

  const handleMediaImport = (event) => {
    addFilesToLibrary(event.target.files);
    event.target.value = '';
  };

  const handleDropMedia = (event) => {
    event.preventDefault();
    addFilesToLibrary(event.dataTransfer.files);
  };

  const openSettings = (tab = 'subtitles') => {
    setSettingsTab(tab);
    setSettingsOpen(true);
    setControlsVisible(true);
  };

  const handleSourceLanguageChange = (nextSource) => {
    if (nextSource === sourceLang) return;
    if (processing || transcribing || translationRunning) {
      setStatusMessage('Wait for the current transcription or translation job before changing its source language.');
      return;
    }
    if (nextSource === 'none' && viewStep === 'player' && cues.length && subtitleOrigin !== 'unprocessed') {
      setStatusMessage('Choose a source language or Auto-detect before regenerating subtitles.');
      return;
    }
    if (viewStep === 'player' && cues.length && subtitleOrigin !== 'unprocessed') {
      setPendingLanguageChange({
        kind: 'source',
        previousValue: sourceLang,
        nextValue: nextSource,
      });
      return;
    }
    setSourceLang(nextSource);
    setDetectedLang(null);
  };

  const handleTargetLanguageChange = (nextTarget) => {
    if (nextTarget === targetLang) return;
    if (processing || transcribing || translationRunning) {
      setStatusMessage('Wait for the current transcription or translation job before changing its target language.');
      return;
    }
    if (viewStep === 'player' && cues.length && subtitleOrigin !== 'unprocessed') {
      setPendingLanguageChange({
        kind: 'target',
        previousValue: targetLang,
        nextValue: nextTarget,
      });
      return;
    }
    setTargetLang(nextTarget);
  };

  const cancelLanguageChange = () => {
    setPendingLanguageChange(null);
    setStatusMessage('Language change cancelled. The current subtitles were kept.');
  };

  const confirmLanguageChange = () => {
    const change = pendingLanguageChange;
    if (!change) return;

    setPendingLanguageChange(null);
    setSettingsOpen(false);
    videoRef.current?.pause();
    setIsPlaying(false);

    if (change.kind === 'source') {
      setSourceLang(change.nextValue);
      setDetectedLang(null);
      processVideo({ sourceLanguage: change.nextValue, targetLanguage: targetLang });
      return;
    }

    setTargetLang(change.nextValue);
    translateCues({ sourceLanguage: sourceLang, targetLanguage: change.nextValue });
  };

  const openPlayer = () => {
    setViewStep('player');
    setSettingsOpen(false);
    setStatusMessage(intent === 'export'
      ? 'Export path ready. Open Export settings when you want output files.'
      : 'Player ready. Controls stay quiet until you need them.');
  };

  const loadSampleProject = async () => {
    setMediaName('LingoLoop sample smoke test');
    setSourceLang('en');
    setTargetLang('ja');
    setDetectedLang('en');
    setSourceMode('transcribe');
    setSubtitleOrigin('sample');
    setActiveEngine('node-whisper');
    setProcessingKind('full');
    setProcessing(true);
    setProcessingStage('Running sample smoke test');
    setProcessingProgress(0.08);

    try {
      const { cues: sampleCues, detectedLanguage, engine, status, logPath, job } = await transcribeVideo(null, {
        engine: 'node-whisper',
        samplePath: SAMPLE_MEDIA_PATH,
        language: 'en',
        quality,
        onProgress: (fraction, stage) => {
          setProcessingStage(stage || 'Running sample smoke test');
          setProcessingProgress(Math.min(0.55, 0.1 + fraction * 0.45));
        },
      });

      setProcessingStage('Translating sample');
      setProcessingProgress(0.64);
      const translated = await translateList(sampleCues.map(enrichCue), detectedLanguage || 'en', 'ja');

      setMediaUrl(SAMPLE_MEDIA_URL);
      setMediaPath('');
      setTranscriptionStatus(status || await refreshTranscriptionStatus(quality));
      setTranscriptionDebug({ engine, job, logPath });
      applyCues(
        translated,
        'transcribe',
        `Sample smoke test completed with ${engine}. ${logPath ? `Log: ${logPath}` : 'Local transcription path verified.'}`,
        'LingoLoop sample smoke test',
      );
      setProcessingProgress(1);
      setProcessingStage('Done');
      setViewStep('player');
    } catch (error) {
      const setupError = error.status === 503 || error.code === 'NO_RECOGNIZER' || error.code === 'NO_MODEL' || error.code === 'NO_SAMPLE';
      setMediaUrl('');
      setMediaPath('');
      setTranscriptionDebug({ error: error.message, job: error.job || null });
      applyCues(
        SAMPLE_FALLBACK_CUES,
        'transcribe',
        setupError
          ? 'Sample preview loaded with bundled fallback cues. Re-check local transcription before running the FFmpeg -> Whisper smoke test.'
          : `Sample smoke test failed: ${error.message}`,
        'LingoLoop sample smoke test',
      );
      setViewStep('config');
    } finally {
      window.setTimeout(() => setProcessing(false), 450);
    }
  };

  const handleSidecarImport = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const parsed = parseSubtitleFile(file.name, text);
    setSidecarName(file.name);
    applyCues(parsed, 'sidecar', parsed.length ? `Parsed ${parsed.length} cues from ${file.name}.` : `No cues found in ${file.name}.`);
  };

  const handleBatchImport = async (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;

    const manifest = files.find((file) => /\.(json|csv|txt)$/i.test(file.name));
    if (manifest) {
      try {
        const parsed = parseBatchManifest(manifest.name, await manifest.text());
        setQueue(parsed);
        setManifestSummary(`${parsed.length} jobs loaded from ${manifest.name}`);
        setStatusMessage(`Batch manifest accepted: ${parsed.length} jobs queued.`);
      } catch (error) {
        setStatusMessage(`Manifest error: ${error.message}`);
      }
      return;
    }

    const nextQueue = files.map((file, index) => makeQueueItem(file.name, index, { quality, targets: [targetLang] }));
    setQueue(nextQueue);
    setManifestSummary(`${nextQueue.length} media files queued`);
    setStatusMessage(`${nextQueue.length} media files queued for offline processing.`);
  };

  // Full "video -> dual subtitles" pipeline, shown behind the loading screen:
  //   1. transcribe with the local native worker, then
  //   2. translate the resulting cues into the target language.
  const processVideo = async (options = {}) => {
    const file = mediaFileRef.current;
    const jobSourceLang = options.sourceLanguage || sourceLang;
    const jobTargetLang = options.targetLanguage || targetLang;
    if (!file && !mediaPath) {
      setStatusMessage('Import a video or audio file before transcribing.');
      return;
    }
    if (!jobSourceLang || jobSourceLang === 'none') {
      setStatusMessage('Pick a source language or choose "Auto-detect" before transcribing.');
      openSettings('languages');
      return;
    }
    // Lock the language/model selections for this job. UI changes made while
    // the async pipeline is running must only affect the next job.
    const jobQuality = quality;

    videoRef.current?.pause();
    setIsPlaying(false);
    setSourceMode('transcribe');
    setTranscribing(true);
    setTranslationDone(false);
    setActiveEngine('node-whisper');
    setSubtitleOrigin('unprocessed');
    setTranscriptionTrace(createTranscriptionTrace(file, mediaPath));
    setTranscriptionDebug(null);
    processingCancelRef.current = false;
    setProcessingKind('full');
    setProcessing(true);
    setProcessingProgress(0.02);
    setProcessingStage('Preparing');

    try {
      updateTranscriptionTrace('preflight', 'running', 'Checking the local native transcription worker.');
      const pipelineStatus = await refreshTranscriptionStatus(jobQuality);
      if (!pipelineStatus.ready) {
        const missing = missingTranscriptionChecks(pipelineStatus);
        const error = `Local transcription is not ready. Missing: ${missing.join(', ')}. Reinstall the app dependencies, then use Re-check transcription.`;
        updateTranscriptionTrace('preflight', 'failed', error);
        setTranscriptionDebug({ error, status: pipelineStatus });
        setStatusMessage(error);
        return;
      }
      updateTranscriptionTrace('preflight', 'done', 'FFmpeg, ffprobe, the local recognizer, and the selected model are ready.');

      updateTranscriptionTrace(
        'transfer',
        'running',
        mediaPath ? 'Sending the Electron desktop path to the local route.' : 'Uploading the selected browser File to the local route.',
      );

      // --- Stage 1: transcription -------------------------------------------
      const {
        cues: asrCues,
        detectedLanguage,
        effectiveQuality,
        autoUpgraded,
        languageDetection,
        recoveredCueCount,
        attemptedGapRecoveries,
        engine,
        status,
        logPath,
        job,
      } = await transcribeVideo(file, {
        engine: 'node-whisper',
        language: jobSourceLang,
        quality: jobQuality,
        mediaPath,
        onEngine: (eng) => setActiveEngine(eng),
        onProgress: (fraction, stage) => {
          if (processingCancelRef.current) return;
          const normalizedStage = String(stage || '').toLowerCase();
          if (normalizedStage.includes('upload') || normalizedStage.includes('desktop path')) {
            updateTranscriptionTrace('transfer', 'running', stage);
          } else if (normalizedStage.includes('transcrib') || normalizedStage.includes('smoke')) {
            updateTranscriptionTrace('transfer', 'done', 'The actual media input reached the selected engine.');
            updateTranscriptionTrace('native', 'running', stage || 'Creating source-language cues.');
          } else if (normalizedStage.includes('reading cues')) {
            updateTranscriptionTrace('native', 'done', 'Speech recognition completed.');
            updateTranscriptionTrace('cues', 'running', 'Reading timestamped cue data.');
          }
          setProcessingStage(stage || 'Transcribing');
          // Transcription occupies the first ~55% of the bar.
          setProcessingProgress(Math.min(0.55, 0.1 + fraction * 0.45));
        },
      });

      if (processingCancelRef.current) return;

      if (!asrCues.length) {
        setCues([]);
        updateTranscriptionTrace('cues', 'failed', 'The engine returned no spoken cue text for this file.');
        setStatusMessage('No speech was detected in this file. Try a different source or check the audio track.');
        return;
      }

      const detected = detectedLanguage || null;
      if (jobSourceLang === 'detect' && detected) {
        setDetectedLang(detected);
      }
      if (autoUpgraded && effectiveQuality === 'best') {
        setQuality('best');
        setCleanup(qualityPresets.best.cleanup);
      }
      if (status) setTranscriptionStatus(status);
      setTranscriptionDebug({
        engine,
        job,
        logPath,
        status,
        languages: { source: jobSourceLang, detected, target: jobTargetLang },
        smartAuto: {
          effectiveQuality,
          autoUpgraded,
          confidence: languageDetection?.confidence || 0,
          evidence: languageDetection?.evidence || null,
        },
        gapRecovery: { attempted: attemptedGapRecoveries, recovered: recoveredCueCount },
      });
      updateTranscriptionTrace('transfer', 'done', 'The actual media input reached the selected engine.');
      updateTranscriptionTrace(
        'native',
        'done',
        autoUpgraded
          ? `${sourceLangLabel(detected)} detected; restarted from 0:00 with Whisper Small (Best).`
          : 'ffprobe, FFmpeg, and local Whisper completed.',
      );
      updateTranscriptionTrace(
        'cues',
        'done',
        `${asrCues.length} timestamped source cues were created; recovered ${recoveredCueCount || 0} cue${recoveredCueCount === 1 ? '' : 's'} from uncovered speech regions.`,
      );

      // --- Stage 2: translation ---------------------------------------------
      setProcessingStage(`Translating to ${languageLabel(jobTargetLang)}`);
      setProcessingProgress(0.62);
      updateTranscriptionTrace('translation', 'running', `Translating ${asrCues.length} real source cues.`);

      const effectiveSource = (jobSourceLang === 'detect' || jobSourceLang === 'none')
        ? (detected || 'auto')
        : jobSourceLang;

      const enrichedAsr = asrCues.map(enrichCue);
      setTranslationRunning(true);
      const translated = await translateList(enrichedAsr, effectiveSource, jobTargetLang, (completed, total, recovery) => {
        if (processingCancelRef.current) return;
        setProcessingStage(recovery?.recovering
          ? `Retrying subtitle ${recovery.current} of ${recovery.total}`
          : `Translating cue ${completed} of ${total} to ${languageLabel(jobTargetLang)}`);
        setProcessingProgress(recovery?.recovering
          ? 0.93
          : 0.62 + (completed / Math.max(1, total)) * 0.3);
      }, () => processingCancelRef.current);
      setTranslationRunning(false);

      if (processingCancelRef.current) return;

      setProcessingStage('Finalizing');
      setProcessingProgress(0.95);

      const finalCues = normalizeCuesForPlayback(translated);
      const failedTranslations = countTranslationFailures(finalCues);
      const translationsReady = failedTranslations === 0;
      setCues(finalCues);
      setSourceMode('transcribe');
      setTranslationDone(translationsReady);
      setPlaybackTime(finalCues[0]?.start ?? 0);
      setSelectedWord(finalCues[0]?.words?.[0] ?? null);
      setSubtitleOrigin('transcription');
      if (translationsReady) recordSubtitleLog(finalCues, 'transcribe');
      if (activeItemIdRef.current) {
        updateLibraryItem(activeItemIdRef.current, {
          status: translationsReady ? 'done' : 'failed',
          progress: translationsReady ? 100 : 90,
          stage: translationsReady ? 'Ready' : 'Translation failed',
          error: translationsReady ? null : `${failedTranslations} subtitle translation${failedTranslations === 1 ? '' : 's'} failed.`,
          cues: finalCues,
          detectedLang: detected,
          sourceLanguage: jobSourceLang,
          translatedTo: jobTargetLang,
        });
      }
      updateTranscriptionTrace(
        'translation',
        translationsReady ? 'done' : 'failed',
        translationsReady
          ? `Translated to ${languageLabel(jobTargetLang)}.`
          : `${failedTranslations} cue translation${failedTranslations === 1 ? '' : 's'} failed after retrying.`,
      );
      updateTranscriptionTrace(
        'render',
        translationsReady ? 'done' : 'queued',
        translationsReady
          ? 'The subtitle viewer is using the cues from this imported file.'
          : 'Playback remains locked until every cue has a translation.',
      );

      setProcessingProgress(1);
      setProcessingStage(translationsReady ? 'Done' : 'Translation failed');

      const detectNote = jobSourceLang === 'detect' && detected
        ? ` Detected ${sourceLangLabel(detected)}${autoUpgraded ? ' and switched to Best before restarting from the beginning' : ''}.`
        : '';
      const recoveryNote = recoveredCueCount
        ? ` Recovered ${recoveredCueCount} cue${recoveredCueCount === 1 ? '' : 's'} from subtitle gaps.`
        : '';
      const engineNote = ` with ${engine}`;
      const logNote = logPath ? ` Log: ${logPath}.` : '';
      setStatusMessage(translationsReady
        ? `Transcribed ${finalCues.length} cues${engineNote} and translated to ${languageLabel(jobTargetLang)}.${detectNote}${recoveryNote}${logNote}`
        : `Transcription completed, but ${failedTranslations} translation${failedTranslations === 1 ? '' : 's'} could not be recovered after automatic retries. Use Re-translate to try again.${logNote}`);

      // Move the viewer into the player once dual subs are ready. The video
      // stays paused — press Play whenever you're ready.
      setViewStep('player');
      setIsPlaying(false);
    } catch (error) {
      if (!processingCancelRef.current) {
        const nativeStage = error.job?.stage || error.stage || 'native-pipeline';
        const recognitionRejected = error.code === 'ASR_HALLUCINATION' || error.code === 'NO_SPEECH';
        const traceStage = nativeStage === 'preflight'
          ? 'preflight'
          : nativeStage === 'parsing-cues' || nativeStage === 'parse-cues'
            ? 'cues'
            : 'native';
        updateTranscriptionTrace(traceStage, 'failed', error.message);
        setTranscriptionDebug({ error: error.message, job: error.job || null, status: error.statusInfo || null });
        if (recognitionRejected) {
          setProcessingStage('Speech recognition produced no usable text');
          setProcessingProgress(0.58);
          setStatusMessage(`Speech recognition failed after audio extraction succeeded: ${error.message}`);
        } else {
          setProcessingStage('Processing failed');
          setStatusMessage(`Processing failed: ${error.message}`);
        }
      }
    } finally {
      setTranslationRunning(false);
      setTranscribing(false);
      // Let the completed bar render briefly before it disappears.
      window.setTimeout(() => setProcessing(false), 450);
    }
  };

  const startProject = () => {
    if (mediaFileRef.current && subtitleOrigin === 'unprocessed') {
      processVideo();
      return;
    }
    openPlayer();
  };

  const cancelProcessing = () => {
    processingCancelRef.current = true;
    setProcessing(false);
    setTranscribing(false);
    setTranslationRunning(false);
    setTranslationDone(false);
    setStatusMessage(processingKind === 'translation'
      ? 'Subtitle translation cancelled. The selected language is saved; use Re-translate when you are ready.'
      : 'Transcription cancelled. You can adjust settings and try again.');
  };

  // Background transcription for a library item (no full-screen overlay), so
  // a whole folder of videos can be processed while you keep watching.
  const transcribeLibraryItem = async (item, options = {}) => {
    if (!item?.file || item.status === 'processing' || (!options.force && item.cues?.length)) return false;
    const jobSourceLang = options.sourceLanguage || item.sourceLanguage || sourceLang;
    const jobTargetLang = options.targetLanguage || item.translatedTo || targetLang;
    const jobQuality = options.quality || quality;
    updateLibraryItem(item.id, {
      status: 'processing',
      progress: 2,
      stage: options.force ? 'Preparing regeneration' : 'Preparing',
      error: null,
      sourceLanguage: jobSourceLang,
      translatedTo: jobTargetLang,
    });
    try {
      const { cues: asrCues, detectedLanguage } = await transcribeVideo(item.file, {
        engine: 'node-whisper',
        language: jobSourceLang,
        quality: jobQuality,
        mediaPath: item.path,
        onProgress: (fraction, stage) => {
          updateLibraryItem(item.id, {
            progress: Math.min(60, Math.round(10 + fraction * 50)),
            stage: stage || 'Transcribing',
          });
        },
      });
      if (!asrCues.length) throw new Error('No speech was detected in this file.');

      const effectiveSource = (jobSourceLang === 'detect' || jobSourceLang === 'none')
        ? (detectedLanguage || 'auto')
        : jobSourceLang;
      updateLibraryItem(item.id, { progress: 70, stage: `Translating to ${languageLabel(jobTargetLang)}` });
      const translated = await translateList(asrCues.map(enrichCue), effectiveSource, jobTargetLang);
      const finalCues = normalizeCuesForPlayback(translated);
      const failedTranslations = countTranslationFailures(finalCues);
      const translationsReady = failedTranslations === 0;
      const keepPreviousResult = options.force && !translationsReady && Boolean(item.cues?.length);

      updateLibraryItem(item.id, {
        status: translationsReady ? 'done' : 'failed',
        progress: translationsReady ? 100 : 90,
        stage: translationsReady ? 'Ready' : 'Translation failed',
        error: translationsReady ? null : `${failedTranslations} subtitle translation${failedTranslations === 1 ? '' : 's'} failed.`,
        cues: keepPreviousResult ? item.cues : finalCues,
        detectedLang: keepPreviousResult ? item.detectedLang : (detectedLanguage || null),
        sourceLanguage: jobSourceLang,
        translatedTo: jobTargetLang,
      });
      // If this video is on screen right now, show its fresh subtitles.
      if (activeItemIdRef.current === item.id && !keepPreviousResult) {
        setCues(finalCues);
        setTranslationDone(translationsReady);
        setSubtitleOrigin('transcription');
        setDetectedLang(detectedLanguage || null);
        setSourceLang(jobSourceLang);
        setTargetLang(jobTargetLang);
        setPlaybackTime(finalCues[0]?.start ?? 0);
        setSelectedWord(finalCues[0]?.words?.[0] ?? null);
        if (translationsReady) recordSubtitleLog(finalCues, 'transcribe', item.name);
      }
      return translationsReady;
    } catch (error) {
      updateLibraryItem(item.id, { status: 'failed', stage: 'Failed', error: error.message });
      return false;
    }
  };

  const openRegenerationDialog = (item) => {
    if (!item) return;
    if (processing || batchRunning || regenerationRunning || item.status === 'processing') {
      setStatusMessage('Wait for the current subtitle job to finish before starting another regeneration.');
      return;
    }
    setRegenerationRequest({
      itemId: item.id,
      sourceLanguage: item.sourceLanguage || sourceLang || 'detect',
      targetLanguage: item.translatedTo || targetLang,
    });
  };

  const confirmLibraryRegeneration = async () => {
    const request = regenerationRequest;
    const item = libraryRef.current.find((entry) => entry.id === request?.itemId);
    if (!request || !item || regenerationRunning) return;

    setRegenerationRunning(true);
    setRegenerationRequest(null);
    if (activeItemIdRef.current === item.id) {
      videoRef.current?.pause();
      setIsPlaying(false);
      setSourceLang(request.sourceLanguage);
      setTargetLang(request.targetLanguage);
    }
    setStatusMessage(`Regenerating subtitles for ${item.name} from ${sourceLangLabel(request.sourceLanguage)}…`);
    try {
      const succeeded = await transcribeLibraryItem(item, {
        force: true,
        sourceLanguage: request.sourceLanguage,
        targetLanguage: request.targetLanguage,
      });
      setStatusMessage(succeeded
        ? `Regenerated subtitles for ${item.name} from ${sourceLangLabel(request.sourceLanguage)} and translated them to ${languageLabel(request.targetLanguage)}.`
        : `Regeneration did not complete for ${item.name}. The previous subtitles were kept; open the library to review the error and try again.`);
    } finally {
      setRegenerationRunning(false);
    }
  };

  const processAllPending = async () => {
    if (batchRunning) return;
    const pending = libraryRef.current.filter((item) => !item.cues?.length && item.status !== 'processing');
    if (!pending.length) {
      setStatusMessage('Every video in the library already has subtitles.');
      return;
    }
    setBatchRunning(true);
    setStatusMessage(`Creating subtitles for ${pending.length} video${pending.length > 1 ? 's' : ''}, one at a time…`);
    try {
      for (const item of pending) {
        // Sequential on purpose: one whisper.cpp job at a time.
        await transcribeLibraryItem(item);
      }
      setStatusMessage('Library processing finished.');
    } finally {
      setBatchRunning(false);
    }
  };

  const chooseSourceMode = (nextMode) => {
    if (nextMode === 'sidecar' && !sidecarName) {
      setSourceMode('sidecar');
      setStatusMessage('Choose a sidecar subtitle file to parse cues.');
      sidecarInputRef.current?.click();
      return;
    }
    if (nextMode === 'transcribe') {
      processVideo();
      return;
    }
    setSourceMode(nextMode);
    setSubtitleOrigin('unprocessed');
    setCues([]);
    setPlaybackTime(0);
    setSelectedWord(null);
    setTranslationDone(false);
    setStatusMessage('Embedded subtitle extraction is not available yet. Choose Transcribe for this MP4 or import a sidecar file.');
  };

  const mediaDuration = duration || cues[cues.length - 1]?.end || 0;
  const positionKey = mediaName ? `${mediaName}:${mediaFileRef.current?.size || 0}` : null;

  const syncVideoTime = (time) => {
    const clamped = clamp(time, 0, mediaDuration || time);
    if (videoRef.current) videoRef.current.currentTime = clamped;
    setPlaybackTime(clamped);
  };

  const seekBy = (delta) => {
    const current = videoRef.current?.currentTime ?? playbackTime;
    syncVideoTime(current + delta);
    revealPlayerChrome();
  };

  const seekFromClientX = (clientX) => {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !mediaDuration) return;
    const fraction = clamp((clientX - rect.left) / rect.width, 0, 1);
    syncVideoTime(fraction * mediaDuration);
  };

  // VLC-style scrubbing: click anywhere on the bar to jump, drag to scrub.
  const handleSeekPointerDown = (event) => {
    event.preventDefault();
    seekFromClientX(event.clientX);
    const handleMove = (moveEvent) => seekFromClientX(moveEvent.clientX);
    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  };

  const toggleMute = () => {
    setMuted((value) => {
      const next = !value;
      if (videoRef.current) videoRef.current.muted = next;
      return next;
    });
  };

  const toggleFullscreen = () => {
    if (typeof document === 'undefined') return;
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      videoFrameRef.current?.requestFullscreen?.().catch(() => {});
    }
  };

  const cyclePlaybackRate = () => {
    const index = PLAYBACK_RATES.indexOf(playbackRate);
    const next = PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length];
    setPlaybackRate(next);
    if (videoRef.current) videoRef.current.playbackRate = next;
    setStatusMessage(`Playback speed: ${next}×`);
  };

  const revealPlayerChrome = () => {
    setControlsVisible(true);
    if (controlsTimerRef.current) window.clearTimeout(controlsTimerRef.current);
    if (viewStep === 'player' && isPlaying && !settingsOpen) {
      controlsTimerRef.current = window.setTimeout(() => setControlsVisible(false), 2200);
    }
  };

  const chooseCue = (cue) => {
    syncVideoTime(cue.start);
    setSelectedWord(cue.words[0]);
  };

  const togglePlayback = async () => {
    setControlsVisible(true);
    if (!playbackReady) {
      videoRef.current?.pause();
      setIsPlaying(false);
      setStatusMessage('Playback stays paused until transcription and translation are complete.');
      return;
    }
    if (videoRef.current && mediaUrl) {
      if (videoRef.current.paused) {
        try {
          await videoRef.current.play();
        } catch (error) {
          setIsPlaying(false);
          setStatusMessage(`Playback could not start: ${error.message}`);
        }
      } else {
        videoRef.current.pause();
        setIsPlaying(false);
      }
      return;
    }

    if (simulationRef.current) {
      window.clearInterval(simulationRef.current);
      simulationRef.current = null;
      setIsPlaying(false);
      return;
    }

    setIsPlaying(true);
    simulationRef.current = window.setInterval(() => {
      setPlaybackTime((current) => {
        const maxEnd = cues[cues.length - 1]?.end ?? 20;
        return current >= maxEnd ? cues[0]?.start ?? 0 : current + 0.25;
      });
    }, 250);
  };

  const loopCurrentCue = () => {
    if (!activeCue) return;
    syncVideoTime(activeCue.start);
    setStatusMessage(`Looped cue at ${secondsToClock(activeCue.start)}.`);
  };

  const mineCurrentCue = () => {
    if (!activeCue) return;
    setSavedCards((current) => {
      if (current.some((card) => card.cueId === activeCue.id)) return current;
      return [
        ...current,
        {
          id: `card-${activeCue.id}`,
          cueId: activeCue.id,
          front: activeCue.original,
          back: activeCue.translation,
          fsrs: { due: Date.now(), stability: 0.4, difficulty: 0.5, reps: 0 },
        },
      ];
    });
    setStatusMessage('Saved this loop as an FSRS review card.');
  };

  const shadowCurrentCue = () => {
    if (!activeCue) return;
    setStatusMessage('Shadowing scorer armed. Recording/alignment lands in the media worker phase.');
  };

  // Translate an explicit list of cues and return the translated array. Shared
  // by the "Batch translate" button and the transcribe->translate pipeline so
  // both use identical batching/fallback behaviour.
  const translateList = async (list, effectiveSource, target, onProgress, shouldCancel = () => false) => {
    const translateOne = async (cue) => {
      const translationContext = {
        cueId: cue.id,
        from: effectiveSource,
        to: target,
        original: cue.original,
      };
      let lastFailure = 'Translation failed for an unknown reason.';
      let retryAfterMs = 0;

      for (let attempt = 1; attempt <= TRANSLATION_MAX_ATTEMPTS; attempt += 1) {
        const controller = new AbortController();
        const timeout = window.setTimeout(
          () => controller.abort(`Translation timed out after ${TRANSLATION_TIMEOUT_MS / 1000} seconds.`),
          TRANSLATION_TIMEOUT_MS,
        );

        try {
          console.log('[Translation] Request started', {
            ...translationContext,
            attempt,
            maxAttempts: TRANSLATION_MAX_ATTEMPTS,
            timeoutMs: TRANSLATION_TIMEOUT_MS,
          });
          const response = await fetch('/api/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              text: cue.original,
              from: effectiveSource,
              to: target,
              llmModel: 'none',
              useCache: cacheEnabled,
            }),
          });

          if (response.ok) {
            const data = await response.json();
            const translatedText = typeof data.text === 'string' ? data.text.trim() : '';
            if (!translatedText) {
              lastFailure = 'The translation API returned an empty result.';
              console.warn('[Translation] Empty response; cue will be retried', {
                ...translationContext,
                attempt,
                status: response.status,
                response: data,
              });
              continue;
            }

            const unchanged = translatedText === cue.original.trim();
            if (unchanged) {
              console.warn('[Translation] Warning: API returned text identical to the original', {
                ...translationContext,
                attempt,
                status: response.status,
                translated: translatedText,
              });
            } else {
              console.log('[Translation] Success', {
                ...translationContext,
                attempt,
                status: response.status,
                translated: translatedText,
              });
            }
            return { ...cue, translation: translatedText, translationError: null };
          }

          const errorBody = await response.text().catch(() => '');
          let errorData = null;
          try {
            errorData = JSON.parse(errorBody);
          } catch {
            // Keep the raw response for diagnostics.
          }
          retryAfterMs = response.status === 429
            ? Math.max(1000, Number(errorData?.retryAfterMs) || Number(response.headers.get('Retry-After')) * 1000 || 8000)
            : response.status >= 500
              ? 1200 * attempt
              : 600;
          lastFailure = `Translation API returned HTTP ${response.status}${errorBody ? `: ${errorBody}` : ''}`;
          console.warn('[Translation] Request failed; cue will be retried when eligible', {
            ...translationContext,
            attempt,
            status: response.status,
            response: errorBody,
          });
        } catch (error) {
          const aborted = controller.signal.aborted;
          lastFailure = aborted
            ? `Translation timed out after ${TRANSLATION_TIMEOUT_MS / 1000} seconds.`
            : (error instanceof Error ? error.message : String(error));
          console.warn('[Translation] Request exception; cue will be retried', {
            ...translationContext,
            attempt,
            error: lastFailure,
            aborted,
          });
        } finally {
          window.clearTimeout(timeout);
        }

        if (attempt < TRANSLATION_MAX_ATTEMPTS) {
          console.warn('[Translation] Retrying failed cue', {
            ...translationContext,
            nextAttempt: attempt + 1,
            reason: lastFailure,
            retryAfterMs,
          });
          if (retryAfterMs) {
            await new Promise((resolve) => window.setTimeout(resolve, retryAfterMs));
          }
        }
      }

      console.warn('[Translation] Cue still failed after this pass', {
        ...translationContext,
        attempts: TRANSLATION_MAX_ATTEMPTS,
        error: lastFailure,
      });
      return {
        ...cue,
        translation: cue.translation || cue.original,
        translationError: lastFailure,
      };
    };

    // Bounded worker pool: honours the Concurrency setting instead of firing
    // every cue at once (which rate-limited the translator on long videos).
    const maxWorkers = Math.max(1, Math.min(12, Number(concurrency) || 4));
    const results = new Array(list.length);
    let nextIndex = 0;
    let completedCount = 0;
    const worker = async () => {
      while (nextIndex < list.length) {
        const index = nextIndex++;
        results[index] = await translateOne(list[index]);
        completedCount += 1;
        onProgress?.(completedCount, list.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(maxWorkers, list.length) }, worker));

    // A large batch can still contain a few transient failures after its
    // concurrent pass. Retry only those cues, one at a time, after a short
    // cooldown so an intermittent upstream limit does not fail the project.
    const initiallyFailedIndexes = results.reduce((indexes, cue, index) => {
      if (cue?.translationError) indexes.push(index);
      return indexes;
    }, []);
    if (initiallyFailedIndexes.length && !shouldCancel()) {
      console.warn('[Translation] Retrying failed cues sequentially', {
        failed: initiallyFailedIndexes.length,
        total: results.length,
      });
      await new Promise((resolve) => window.setTimeout(resolve, TRANSLATION_RECOVERY_DELAY_MS));
      for (let recoveryIndex = 0; recoveryIndex < initiallyFailedIndexes.length; recoveryIndex += 1) {
        if (shouldCancel()) break;
        const cueIndex = initiallyFailedIndexes[recoveryIndex];
        onProgress?.(
          results.length,
          results.length,
          { recovering: true, current: recoveryIndex + 1, total: initiallyFailedIndexes.length },
        );
        results[cueIndex] = await translateOne(results[cueIndex]);
      }
    }

    const failed = countTranslationFailures(results);
    const summary = {
      from: effectiveSource,
      to: target,
      total: results.length,
      succeeded: results.length - failed,
      failed,
    };
    if (failed) console.warn('[Translation] Batch completed with unrecovered cues', summary);
    else console.log('[Translation] Batch completed successfully', summary);
    return results;
  };

  const translateCues = async (options = {}) => {
    const jobSourceLang = options.sourceLanguage || sourceLang;
    const jobTargetLang = options.targetLanguage || targetLang;
    // Never send the 'detect'/'none' sentinels to the translator. Use the
    // recognised language when we have it, otherwise let the translator
    // auto-detect the source ('auto').
    const effectiveSource = (jobSourceLang === 'detect' || jobSourceLang === 'none')
      ? (detectedLang || 'auto')
      : jobSourceLang;

    if (!cues.length || transcribing || processing || translationRunning) return;
    videoRef.current?.pause();
    setIsPlaying(false);
    setStatusMessage(`Batch translating ${cues.length} cues from ${sourceLangLabel(effectiveSource)} to ${languageLabel(jobTargetLang)} with concurrency ${concurrency}.`);
    setTranslationDone(false);
    setTranslationRunning(true);
    processingCancelRef.current = false;
    setProcessingKind('translation');
    setProcessingStage(`Preparing ${cues.length} subtitle cues`);
    setProcessingProgress(0.05);
    setProcessing(true);

    try {
      const translated = await translateList(cues, effectiveSource, jobTargetLang, (completed, total, recovery) => {
        if (processingCancelRef.current) return;
        setProcessingStage(recovery?.recovering
          ? `Retrying subtitle ${recovery.current} of ${recovery.total}`
          : `Translating cue ${completed} of ${total} to ${languageLabel(jobTargetLang)}`);
        setProcessingProgress(recovery?.recovering
          ? 0.93
          : 0.08 + (completed / Math.max(1, total)) * 0.84);
      }, () => processingCancelRef.current);
      if (processingCancelRef.current) return;

      setProcessingStage('Finalizing regenerated subtitles');
      setProcessingProgress(0.96);
      const finalCues = normalizeCuesForPlayback(translated);
      const failedTranslations = countTranslationFailures(finalCues);
      const translationsReady = failedTranslations === 0;

      setCues(finalCues);
      setTranslationDone(translationsReady);
      if (activeItemIdRef.current) {
        updateLibraryItem(activeItemIdRef.current, {
          cues: finalCues,
          status: translationsReady ? 'done' : 'failed',
          progress: translationsReady ? 100 : 90,
          stage: translationsReady ? 'Ready' : 'Translation failed',
          error: translationsReady ? null : `${failedTranslations} subtitle translation${failedTranslations === 1 ? '' : 's'} failed.`,
          sourceLanguage: jobSourceLang,
          translatedTo: jobTargetLang,
        });
      }
      if (translationsReady) {
        recordSubtitleLog(finalCues, sourceMode);
        setStatusMessage(cacheEnabled
          ? `Translations to ${languageLabel(jobTargetLang)} are ready. Repeated lines will hit cache on re-run.`
          : `Translations to ${languageLabel(jobTargetLang)} are ready. Cache is disabled.`);
      } else {
        setStatusMessage(`${failedTranslations} translation${failedTranslations === 1 ? '' : 's'} could not be recovered after automatic retries. Playback and export remain locked; use Re-translate to try again.`);
      }
      setProcessingProgress(1);
      setProcessingStage(translationsReady ? 'Subtitles ready' : 'Translation completed with errors');
    } catch (error) {
      if (!processingCancelRef.current) {
        setProcessingStage('Translation failed');
        setStatusMessage(`Translation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      setTranslationRunning(false);
      window.setTimeout(() => setProcessing(false), 450);
    }
  };

  const toggleFormat = (format) => {
    setFormats((current) => ({ ...current, [format]: !current[format] }));
  };

  const startQueue = () => {
    setQueue((current) => current.map((job) => job.status === 'done' ? job : { ...job, status: 'queued' }));
    setQueueRunning(true);
    setStatusMessage('Offline batch queue started. Jobs resume by stage.');
  };

  const cancelQueue = () => {
    setQueueRunning(false);
    setQueue((current) => current.map((job) => job.status === 'running' ? { ...job, status: 'queued', stage: 'paused' } : job));
    setStatusMessage('Queue paused. Resume when ready.');
  };

  const prioritizeJob = (id) => {
    setQueue((current) => current.map((job) => job.id === id ? { ...job, priority: !job.priority } : job));
  };

  const retryJob = (id) => {
    setQueue((current) => current.map((job) => job.id === id ? { ...job, status: 'queued', progress: 0, stage: 'waiting' } : job));
  };

  const exportSelected = () => {
    if (!translationDone || translationRunning) {
      setStatusMessage('Export is locked until every subtitle cue has a completed translation.');
      return;
    }
    const selected = Object.entries(formats).filter(([, enabled]) => enabled).map(([format]) => format);
    if (!selected.length) {
      setStatusMessage('Choose at least one export format.');
      return;
    }

    const baseName = mediaName.replace(/\.[^.]+$/, '') || 'dual-live-translations';
    if (formats.srt) downloadText(`${baseName}.dual.srt`, makeSrt(cues));
    if (formats.ass) downloadText(`${baseName}.dual.ass`, makeAss(cues, {
      original: subtitleOriginalColor,
      translation: subtitleTranslationColor,
    }));
    if (formats.json) {
      downloadText(`${baseName}.project.json`, JSON.stringify({
        mediaName,
        source: { mode: sourceMode, lang: sourceLang },
        targets: [targetLang],
        quality,
        cleanup,
        subtitleColors: { original: subtitleOriginalColor, translation: subtitleTranslationColor },
        subtitleMask: maskSettings,
        cues,
        queue,
      }, null, 2), 'application/json');
    }
    if (formats.report) downloadText(`${baseName}.batch-report.csv`, makeBatchReport(queue), 'text/csv');
    setStatusMessage(`Exported ${selected.map((item) => item.toUpperCase()).join(', ')} files.`);
  };

  return (
    <main className={`app-shell ${mode} step-${viewStep} ${intent}-intent${focusView ? ' focus-view' : ''}${settingsOpen ? ' settings-open' : ''}${viewStep === 'player' && isPlaying && !controlsVisible ? ' controls-hidden' : ' controls-active'}`}>
      <header className="topbar">
        <div className="brand">
          <IconButton label="Open your video library" icon={Menu} onClick={() => setLibraryOpen(true)} />
          <div className="brand-mark"><Languages size={21} /></div>
          <div>
            <h1>{APP_NAME}</h1>
            <p>{mediaName}</p>
          </div>
        </div>
        <div className="topbar-tools">
          <IconButton label="Settings" icon={Settings} onClick={() => openSettings('subtitles')} />
        </div>
      </header>
      <input ref={mediaInputRef} className="sr-only" type="file" multiple accept="video/*,audio/*,.mkv,.mov,.webm,.mp4,.mp3,.wav" onChange={handleMediaImport} />
      <input ref={sidecarInputRef} className="sr-only" type="file" accept=".srt,.vtt,.ass,.ssa,text/plain" onChange={handleSidecarImport} />
      <input ref={batchInputRef} className="sr-only" type="file" accept=".json,.csv,.txt,video/*,audio/*" multiple onChange={handleBatchImport} />

      {processing ? (
        <div className="processing-overlay" role="status" aria-live="polite">
          <div className="processing-card">
            <div className="processing-spinner" aria-hidden="true"><AudioWaveform size={30} /></div>
            <h2>{processingKind === 'translation' ? 'Regenerating translated subtitles' : 'Processing your video'}</h2>
            <p className="processing-file">{mediaName}</p>
            <div className="processing-bar">
              <div className="processing-bar-fill" style={{ width: `${Math.round(processingProgress * 100)}%` }} />
            </div>
            <p className="processing-stage">
              {processingStage || 'Working'}
              {processingKind === 'full' && activeEngine ? ' · local Whisper' : ''}
              {` · ${Math.round(processingProgress * 100)}%`}
            </p>
            {processingKind === 'translation' ? (
              <ol className="processing-steps">
                <li className="done">Keep source text and timing</li>
                <li className={processingProgress >= 0.96 ? 'done' : 'active'}>Translate all cues to {languageLabel(targetLang)}</li>
                <li className={processingProgress >= 1 ? 'done' : processingProgress >= 0.96 ? 'active' : ''}>Refresh subtitles in the player</li>
              </ol>
            ) : (
              <ol className="processing-steps">
                <li className={processingProgress > 0.1 ? 'done' : 'active'}>Extract audio</li>
                <li className={processingProgress >= 0.6 ? 'done' : processingProgress > 0.1 ? 'active' : ''}>
                  Transcribe {sourceLang === 'detect' ? '(auto-detect)' : `(${sourceLangLabel(sourceLang)})`}
                </li>
                <li className={processingProgress >= 1 ? 'done' : processingProgress >= 0.6 ? 'active' : ''}>
                  Translate to {languageLabel(targetLang)}
                </li>
              </ol>
            )}
            <button type="button" className="secondary-action processing-cancel" onClick={cancelProcessing}>Cancel</button>
          </div>
        </div>
      ) : null}

      {viewStep === 'landing' ? (
        <section className="landing-flow" aria-label="Start">
          <div className="landing-intro">
            <h2>Watch anything with dual subtitles</h2>
            <p>Add a video, tell LingoLoop what language is spoken and what to translate it into, and it creates two subtitle lines: the original speech and your translation.</p>
          </div>
          <button
            className="drop-panel"
            type="button"
            onClick={() => mediaInputRef.current?.click()}
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDropMedia}
          >
            <Upload size={36} />
            <strong>Drop your videos here</strong>
            <span>…or click to browse. You can add several files at once — they all go into your library, ready to transcribe.</span>
          </button>
          <div className="landing-langs">
            <SelectControl label="Spoken language" value={sourceLang} onChange={handleSourceLanguageChange} options={sourceLanguages} disabled={processing || transcribing || translationRunning} />
            <SelectControl label="Translate to" value={targetLang} onChange={handleTargetLanguageChange} disabled={processing || transcribing || translationRunning} />
          </div>
          <p className="landing-hint">Not sure what&apos;s spoken? Leave it on Auto-detect. Everything runs locally on your computer — nothing is uploaded.</p>
          <button className="sample-action" type="button" onClick={loadSampleProject} title="Loads a short built-in clip so you can see how the app works">
            <Sparkles size={17} />
            <span>Try it first with a built-in sample clip</span>
          </button>
        </section>
      ) : null}

      {viewStep === 'config' ? (
        <section className="config-flow" aria-label="Configure">
          <div className="config-card">
            <div className="config-media-line">
              <Film size={18} />
              <span>{mediaName}</span>
              <small>{subtitleOrigin === 'unprocessed' ? 'No subtitles yet' : 'Subtitles ready'}</small>
            </div>
            <div className="config-language-grid">
              <SelectControl label="Spoken language" value={sourceLang} onChange={handleSourceLanguageChange} options={sourceLanguages} disabled={processing || transcribing || translationRunning} />
              <SelectControl label="Translate to" value={targetLang} onChange={handleTargetLanguageChange} disabled={processing || transcribing || translationRunning} />
            </div>
            <p className="config-hint">Press the button below and LingoLoop will listen to the video, write down what is said, and translate it. You watch with both lines as subtitles.</p>
            {advancedOpen ? (
              <div className="advanced-summary">
                <div>
                  <span>Subtitle source</span>
                  <div className="source-modes compact-source-modes">
                    {sourceModes.map((item) => (
                      <button key={item.id} type="button" className={sourceMode === item.id ? 'selected' : ''} onClick={() => chooseSourceMode(item.id)}>{item.label}</button>
                    ))}
                  </div>
                </div>
                <span>Quality: {qualityPresets[quality].label} · Local ASR: {whisperReady ? 'ready' : 'needs setup'} · Mask: {subtitleMaskModes.find((item) => item.id === maskMode)?.label}</span>
                <button type="button" className="secondary-action" onClick={() => openSettings('audio')}>Open settings</button>
              </div>
            ) : null}
            <div className="config-actions">
              <button type="button" className="secondary-action" title="Engine, quality, and subtitle source options" onClick={() => setAdvancedOpen((value) => !value)}>{advancedOpen ? 'Hide advanced' : 'Advanced'}</button>
              <button type="button" className="primary-action" onClick={startProject} disabled={processing}>
                {subtitleOrigin === 'unprocessed' && mediaFileRef.current ? <AudioWaveform size={18} /> : <Play size={18} />}
                <span>{subtitleOrigin === 'unprocessed' && mediaFileRef.current ? 'Create subtitles & watch' : 'Watch now'}</span>
              </button>
            </div>
            {pendingCount > 1 ? (
              <button type="button" className="secondary-action full" onClick={processAllPending} disabled={batchRunning}>
                <ListChecks size={16} />
                <span>{batchRunning ? 'Processing your library…' : `Create subtitles for all ${pendingCount} waiting videos`}</span>
              </button>
            ) : null}
            <p className="config-status-line">{statusMessage}</p>
            {transcriptionTrace.length ? (
              <section className="transcription-trace" aria-label="Transcription debug trace">
                <div className="transcription-trace-heading">
                  <strong>MP4 to subtitles</strong>
                  <small>{transcriptionDebug?.job?.id || 'Awaiting run'}</small>
                </div>
                <ol>
                  {transcriptionTrace.map((stage) => (
                    <li key={stage.id} className={stage.status}>
                      <StatusDot status={stage.status} />
                      <span><strong>{stage.label}</strong><small>{stage.detail}</small></span>
                    </li>
                  ))}
                </ol>
                {transcriptionDebug?.job?.logPath ? <p>Native job log: <code>{transcriptionDebug.job.logPath}</code></p> : null}
                {transcriptionDebug?.error ? <p className="trace-error">Last error: {transcriptionDebug.error}</p> : null}
                {transcriptionDebug?.error && transcriptionDebug.status?.ready === false ? <p className="trace-note">Browser-side transcription is disabled for imported media because it cannot reliably decode production video audio.</p> : null}
              </section>
            ) : null}
          </div>
        </section>
      ) : null}

      {viewStep === 'player' ? (
      <section className="workspace">
        <aside className="left-rail" aria-label="Imports and pipeline">
          <button className="rail-section import-zone" type="button" onClick={() => mediaInputRef.current?.click()}>
            <Film size={26} />
            <div><strong>Import media</strong><span>Video/audio preview</span></div>
          </button>
          <button className="rail-section import-zone secondary" type="button" onClick={() => sidecarInputRef.current?.click()}>
            <FileText size={25} />
            <div><strong>Import sidecar</strong><span>SRT, VTT, ASS subtitles</span></div>
          </button>
          <button className="rail-section import-zone batch" type="button" onClick={() => batchInputRef.current?.click()}>
            <FileJson size={25} />
            <div><strong>Batch list</strong><span>JSON, CSV, TXT, or many media files</span></div>
          </button>

          <div className="rail-section">
            <div className="section-title"><span>Pipeline</span><small>{completeCount}/{jobs.length}</small></div>
            <div className="pipeline-list">
              {jobs.map((job) => <PipelineStep key={job.id} job={job} />)}
            </div>
          </div>

          <div className="rail-section compact">
            <div className="section-title"><span>Source mode</span><FileText size={15} /></div>
            <p className="path-text">{sidecarName || mediaName}</p>
            <div className="source-modes">
              {sourceModes.map((item) => (
                <button key={item.id} type="button" className={sourceMode === item.id ? 'selected' : ''} onClick={() => chooseSourceMode(item.id)}>{item.label}</button>
              ))}
            </div>
          </div>
        </aside>

        <section className="stage-column" aria-label="Player and configuration">
          <div className="player-shell" onPointerMove={revealPlayerChrome} onFocusCapture={revealPlayerChrome}>
            <div className="player-topline">
              <div>
                <strong>{mediaName}</strong>
                <span>{sourceLangLabel(detectedLang || sourceLang)} → {languageLabel(targetLang)}</span>
              </div>
              <div className="player-tools">
                <IconButton label="Your video library" icon={Menu} onClick={() => setLibraryOpen(true)} />
                <IconButton
                  label={translationRunning ? 'Translating subtitles' : 'Re-translate the subtitles'}
                  icon={Languages}
                  active={!translationDone || translationRunning}
                  disabled={!cues.length || translationRunning || transcribing || processing}
                  onClick={() => translateCues()}
                />
                <IconButton
                  label={subtitleLog ? `Download session subtitle log (${subtitleLog.cueCount} cues)` : 'No session subtitle log yet'}
                  icon={Download}
                  disabled={!subtitleLog}
                  onClick={downloadSubtitleLog}
                />
                <IconButton label="Subtitle style & position" icon={SlidersHorizontal} onClick={() => openSettings('subtitles')} />
                <IconButton label="Settings" icon={Settings} onClick={() => openSettings('languages')} />
              </div>
            </div>

            <div ref={videoFrameRef} className="video-frame">
              {mediaUrl ? (
                <video
                  ref={videoRef}
                  className="media-preview"
                  src={mediaUrl}
                  onLoadedMetadata={(event) => {
                    const video = event.currentTarget;
                    setDuration(video.duration || 0);
                    video.playbackRate = playbackRate;
                    // Continue watching: jump back to where this video was left.
                    const saved = loadPositions()[positionKey];
                    if (saved?.t > 5 && (!video.duration || saved.t < video.duration - 5)) {
                      video.currentTime = saved.t;
                      setPlaybackTime(saved.t);
                      setStatusMessage(`Resumed from ${clockShort(saved.t)}. Press Play to continue.`);
                    }
                  }}
                  onTimeUpdate={(event) => {
                    const video = event.currentTarget;
                    setPlaybackTime(video.currentTime);
                    // Remember the position every few seconds while playing.
                    if (Math.abs(video.currentTime - positionSaveRef.current) > 3) {
                      positionSaveRef.current = video.currentTime;
                      savePlaybackPosition(positionKey, video.currentTime, video.duration);
                    }
                  }}
                  onPlay={(event) => {
                    if (!playbackReady) {
                      event.currentTarget.pause();
                      setIsPlaying(false);
                      setStatusMessage('Playback stays paused until transcription and translation are complete.');
                      return;
                    }
                    setPlaybackTime(event.currentTarget.currentTime);
                    setIsPlaying(true);
                  }}
                  onSeeking={(event) => setPlaybackTime(event.currentTarget.currentTime)}
                  onSeeked={(event) => setPlaybackTime(event.currentTarget.currentTime)}
                  onPause={(event) => {
                    setIsPlaying(false);
                    savePlaybackPosition(positionKey, event.currentTarget.currentTime, event.currentTarget.duration);
                  }}
                  onEnded={(event) => {
                    setIsPlaying(false);
                    savePlaybackPosition(positionKey, event.currentTarget.duration, event.currentTarget.duration);
                  }}
                  onClick={togglePlayback}
                  onDoubleClick={toggleFullscreen}
                  muted={muted}
                  controls={false}
                />
              ) : (
                <div className="scene-grid" aria-hidden="true"><span /><span /><span /><span /></div>
              )}
              {maskMode !== 'off' && maskMode !== 'hide' ? (
                <div
                  className={`subtitle-mask-overlay ${maskMode}${maskEditing ? ' editing' : ''}`}
                  style={{
                    left: `${maskRect.x * 100}%`,
                    top: `${maskRect.y * 100}%`,
                    width: `${maskRect.w * 100}%`,
                    height: `${maskRect.h * 100}%`,
                    '--mask-opacity': maskOpacity,
                    '--mask-blur': `${maskBlur}px`,
                    '--mask-feather': `${maskFeather}px`,
                  }}
                  onPointerDown={startMaskDrag}
                  aria-label="Subtitle mask preview"
                >
                  <span>{maskMode === 'blur' ? 'Blur mask' : 'Cover mask'}{maskEditing ? ' · drag' : ''}</span>
                  {maskEditing ? <i aria-hidden="true" /> : null}
                </div>
              ) : null}
              {maskMode === 'hide' ? (
                <div className="soft-sub-notice">Original soft subtitle track hidden for preview/export</div>
              ) : null}
              {activeCue ? (
                <div
                  className={`subtitle-stack ${subtitleStyle} ${subtitlePosition}`}
                  style={{
                    '--subtitle-original-color': subtitleOriginalColor,
                    '--subtitle-translation-color': subtitleTranslationColor,
                  }}
                >
                  <h2><span>{activeCue.original}</span></h2>
                  <h3><span>{activeCue.translation}</span></h3>
                </div>
              ) : null}
            </div>

            <div className="transport">
              <button
                type="button"
                className="play-button"
                aria-label={playbackReady ? (isPlaying ? 'Pause (Space)' : 'Play (Space)') : 'Waiting for completed subtitles'}
                title={playbackReady ? (isPlaying ? 'Pause (Space)' : 'Play (Space)') : 'Playback unlocks after transcription and translation finish'}
                disabled={!playbackReady}
                onClick={togglePlayback}
              >
                {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
              </button>
              <IconButton label="Back 10 seconds (←)" icon={Rewind} onClick={() => seekBy(-10)} />
              <IconButton label="Forward 10 seconds (→)" icon={FastForward} onClick={() => seekBy(10)} />
              <div
                ref={timelineRef}
                className="timeline seekable"
                role="slider"
                tabIndex={0}
                aria-label="Seek through the video"
                aria-valuemin={0}
                aria-valuemax={Math.round(mediaDuration) || 0}
                aria-valuenow={Math.round(playbackTime) || 0}
                aria-valuetext={`${clockShort(playbackTime)} of ${clockShort(mediaDuration)}`}
                onPointerDown={handleSeekPointerDown}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowRight') { event.preventDefault(); seekBy(5); }
                  if (event.key === 'ArrowLeft') { event.preventDefault(); seekBy(-5); }
                }}
              >
                <div style={{ width: `${mediaDuration ? Math.min(100, (playbackTime / mediaDuration) * 100) : 0}%` }} />
                <span className="seek-handle" style={{ left: `${mediaDuration ? Math.min(100, (playbackTime / mediaDuration) * 100) : 0}%` }} aria-hidden="true" />
              </div>
              <span className="timecode">{clockShort(playbackTime)} / {clockShort(mediaDuration)}</span>
              <button
                type="button"
                className="icon-button rate-button tooltip-control"
                aria-label={`Playback speed: ${playbackRate}×. Click to change.`}
                data-tooltip={`Playback speed: ${playbackRate}× · click to change`}
                onClick={cyclePlaybackRate}
              >
                {playbackRate}×
              </button>
              <IconButton tooltip label="Replay the current subtitle line" icon={Repeat} onClick={loopCurrentCue} />
              {mode === 'education' ? (
                <>
                  <IconButton tooltip disabled label="Practice speaking this line (shadowing) · Coming Soon" icon={AudioWaveform} onClick={shadowCurrentCue} />
                  <IconButton tooltip disabled label="Save this line as a flashcard · Coming Soon" icon={BookOpen} onClick={mineCurrentCue} />
                </>
              ) : null}
              <IconButton tooltip label={muted ? 'Unmute audio (M)' : 'Mute audio (M)'} icon={muted ? VolumeX : Volume2} active={muted} onClick={toggleMute} />
              <IconButton tooltip label="Enter or exit fullscreen (F)" icon={Maximize2} onClick={toggleFullscreen} />
            </div>
          </div>

          <div className="config-grid">
            <section className="config-panel">
              <div className="panel-heading"><AudioWaveform size={17} /><span>Audio cleanup</span></div>
              <div className="preset-row">
                {Object.entries(qualityPresets).map(([id, preset]) => (
                  <button key={id} type="button" className={quality === id ? 'selected' : ''} onClick={() => handleQualityChange(id)}>
                    <strong>{preset.label}</strong><small>{preset.detail}</small>
                  </button>
                ))}
              </div>
              <div className="toggle-list">
                {cleanupOptions.map((option) => (
                  <label key={option.id} className="toggle-row">
                    <input type="checkbox" checked={cleanup[option.id]} onChange={() => toggleCleanup(option.id)} />
                    <span><strong>{option.label}</strong><small>{option.detail}</small></span>
                  </label>
                ))}
              </div>
            </section>

            <section className="config-panel">
              <div className="panel-heading"><Gauge size={17} /><span>Performance</span></div>
              <div className="metric-grid">
                <label><span>Batch size</span><input type="number" min="5" max="100" value={batchSize} onChange={(event) => setBatchSize(Number(event.target.value) || 50)} /></label>
                <label><span>Concurrency</span><input type="number" min="1" max="12" value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value) || 1)} /></label>
              </div>
              <label className="toggle-row single">
                <input type="checkbox" checked={cacheEnabled} onChange={() => setCacheEnabled((value) => !value)} />
                <span><strong>Content-hash cache</strong><small>Skip repeated translations and completed jobs.</small></span>
              </label>
              <div className="performance-note">
                <FastForward size={16} />
                <span>Plan target: local Whisper one pass, batched translation, bounded concurrency, resumable queue.</span>
              </div>
            </section>

            <section className="config-panel subtitle-mask-panel">
              <div className="panel-heading"><SlidersHorizontal size={17} /><span>Subtitle mask</span><small>{maskMode === 'off' ? 'preview off' : maskSettings.exportFilter}</small></div>
              <div className="mask-mode-grid">
                {subtitleMaskModes.map((item) => (
                  <button key={item.id} type="button" className={maskMode === item.id ? 'selected' : ''} onClick={() => chooseMaskMode(item.id)}>
                    <strong>{item.label}</strong><small>{item.detail}</small>
                  </button>
                ))}
              </div>
              <div className="mask-preset-row">
                {maskPresets.map((preset) => (
                  <button key={preset.id} type="button" onClick={() => applyMaskPreset(preset)}>{preset.label}</button>
                ))}
                <button type="button" className={maskEditing ? 'selected' : ''} onClick={() => setMaskEditing((value) => !value)}>{maskEditing ? 'Editing on' : 'Edit region'}</button>
              </div>
              <div className="mask-slider-grid">
                <label><span>X {pct(maskRect.x)}</span><input type="range" min="0" max="100" value={Math.round(maskRect.x * 100)} onChange={(event) => updateMaskRect('x', event.target.value)} /></label>
                <label><span>Y {pct(maskRect.y)}</span><input type="range" min="0" max="100" value={Math.round(maskRect.y * 100)} onChange={(event) => updateMaskRect('y', event.target.value)} /></label>
                <label><span>W {pct(maskRect.w)}</span><input type="range" min="12" max="100" value={Math.round(maskRect.w * 100)} onChange={(event) => updateMaskRect('w', event.target.value)} /></label>
                <label><span>H {pct(maskRect.h)}</span><input type="range" min="8" max="50" value={Math.round(maskRect.h * 100)} onChange={(event) => updateMaskRect('h', event.target.value)} /></label>
                <label><span>Opacity {Math.round(maskOpacity * 100)}%</span><input type="range" min="20" max="100" value={Math.round(maskOpacity * 100)} onChange={(event) => setMaskOpacity(Number(event.target.value) / 100)} /></label>
                <label><span>Blur {maskBlur}px</span><input type="range" min="2" max="24" value={maskBlur} onChange={(event) => setMaskBlur(Number(event.target.value))} /></label>
                <label><span>Feather {maskFeather}px</span><input type="range" min="0" max="32" value={maskFeather} onChange={(event) => setMaskFeather(Number(event.target.value))} /></label>
              </div>
            </section>
          </div>

          <div className="export-strip">
            <div className="export-progress">
              <div><strong>{runningJob.label}</strong><span>{overallProgress}% overall</span></div>
              <div className="progress-track"><div style={{ width: `${overallProgress}%` }} /></div>
            </div>
            <div className="export-options">
              {exportFormats.map((format) => (
                <button key={format.id} type="button" className={formats[format.id] ? 'selected' : ''} onClick={() => toggleFormat(format.id)}>
                  <span>{format.label}</span><small>{format.detail}</small>
                </button>
              ))}
            </div>
            <button className="export-button" type="button" disabled={!translationDone || translationRunning} onClick={exportSelected}><Download size={18} /><span>Export</span></button>
          </div>
        </section>

        <aside className="right-panel" aria-label="Queue and transcript">
          <div className="panel-tabs" role="tablist" aria-label="Side panel">
            <button role="tab" aria-selected={panelTab === 'queue'} className={panelTab === 'queue' ? 'selected' : ''} type="button" onClick={() => setPanelTab('queue')}><ListChecks size={16} /> Queue</button>
            <button role="tab" aria-selected={panelTab === 'vocab'} className={panelTab === 'vocab' ? 'selected' : ''} type="button" onClick={() => setPanelTab('vocab')}><BookOpen size={16} /> Vocabulary</button>
          </div>

          {panelTab === 'queue' ? (
          <section className="queue-panel">
            <div className="section-title"><span>Offline batch queue</span><small>{manifestSummary}</small></div>
            <div className="queue-summary">
              <span>{queueStats.done} done</span><span>{queueStats.running} running</span><span>{queueStats.queued} queued</span><strong>{queueStats.overall}%</strong>
            </div>
            <div className="queue-actions">
              <button type="button" onClick={startQueue}><Play size={15} /> Start</button>
              <button type="button" onClick={cancelQueue}><Pause size={15} /> Pause</button>
              <button type="button" onClick={() => setQueue((current) => current.map((job) => ({ ...job, status: 'queued', progress: 0, stage: 'waiting' })))}><RotateCcw size={15} /> Reset</button>
            </div>
            <div className="queue-list">
              {queue.map((job) => (
                <article key={job.id} className={`queue-item ${job.status}`}>
                  <div>
                    <strong>{job.input}</strong>
                    <span>{job.stage} · {job.quality} · {job.targets.join(', ')}</span>
                  </div>
                  <div className="mini-progress"><div style={{ width: `${job.progress}%` }} /></div>
                  <div className="queue-item-actions">
                    <small>{job.progress}%</small>
                    <button type="button" className={job.priority ? 'priority' : ''} onClick={() => prioritizeJob(job.id)}>Priority</button>
                    <button type="button" onClick={() => retryJob(job.id)}>Retry</button>
                  </div>
                </article>
              ))}
            </div>
          </section>
          ) : null}

          <div className="subtitle-log-toolbar">
            <div>
              <strong>Session subtitle log</strong>
              <span>
                {subtitleLog
                  ? `${subtitleLog.cueCount} cues · ${clockShort(subtitleLog.duration)} · ${new Date(subtitleLog.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                  : 'No completed subtitle file yet'}
              </span>
            </div>
            <div className="subtitle-log-actions">
              <button type="button" className="icon-button" aria-label="Download temporary SRT log" title="Download temporary SRT log" disabled={!subtitleLog} onClick={downloadSubtitleLog}>
                <Download size={16} />
              </button>
              <button type="button" className="icon-button" aria-label="Clear temporary subtitle log" title="Clear temporary subtitle log" disabled={!subtitleLog} onClick={clearSubtitleLog}>
                <X size={16} />
              </button>
            </div>
          </div>

          <div className="transcript-list">
            {cues.map((cue) => (
              <button type="button" key={cue.id} className={`transcript-row${cue.id === activeCue?.id ? ' active' : ''}`} onClick={() => chooseCue(cue)}>
                <span>{secondsToClock(cue.start)} · {cue.speaker} · {Math.round(cue.confidence * 100)}%</span>
                <strong>{cue.original}</strong>
                <small>{cue.translation}</small>
              </button>
            ))}
          </div>

          {panelTab === 'vocab' ? (
          <div className="word-panel">
            <div className="section-title">
              <span>Vocabulary</span>
              <button type="button" className="icon-button" aria-label="Clear selected word" onClick={() => setSelectedWord(null)}><X size={15} /></button>
            </div>
            <div className="word-cloud">
              {vocabulary.map((word, index) => (
                <WordChip key={`${word.text}-${index}`} word={word} selected={currentWord?.text === word.text} onClick={() => setSelectedWord(word)} />
              ))}
            </div>
            <div className="definition-card">
              <small>{currentWord?.freq ?? 'study'} word</small>
              <strong>{currentWord?.text ?? 'No word selected'}</strong>
              <span>{currentWord?.reading ?? 'Import or select a cue to build vocabulary.'}</span>
              <p>Vocabulary is derived from cues and updates when sidecar or batch data changes.</p>
            </div>
          </div>
          ) : null}
        </aside>
      </section>
      ) : null}

      {libraryOpen ? (
        <div className="library-backdrop" role="presentation" onMouseDown={() => setLibraryOpen(false)}>
          <aside className="library-drawer" aria-label="Video library" onMouseDown={(event) => event.stopPropagation()}>
            <div className="library-head">
              <div>
                <strong>Your library</strong>
                <span>Watch a video, correct its language, or regenerate its subtitles.</span>
              </div>
              <button type="button" className="icon-button" aria-label="Close library" onClick={() => setLibraryOpen(false)}><X size={18} /></button>
            </div>
            <div className="library-actions">
              <button type="button" className="secondary-action" title="Add more videos — you can select several at once" onClick={() => mediaInputRef.current?.click()}>
                <Plus size={16} /><span>Add videos</span>
              </button>
              <button
                type="button"
                className="secondary-action"
                title="Transcribe and translate every video that doesn't have subtitles yet, one at a time"
                onClick={processAllPending}
                disabled={batchRunning || !pendingCount}
              >
                <AudioWaveform size={16} />
                <span>{batchRunning ? 'Processing…' : `Subtitle all${pendingCount ? ` (${pendingCount})` : ''}`}</span>
              </button>
            </div>
            <div className="library-list">
              {library.length ? library.map((item) => {
                const itemBusy = processing || batchRunning || regenerationRunning || item.status === 'processing';
                const sourceSummary = item.sourceLanguage === 'detect'
                  ? (item.detectedLang ? `Detected ${sourceLangLabel(item.detectedLang)}` : 'Auto-detect')
                  : item.sourceLanguage ? sourceLangLabel(item.sourceLanguage) : 'Not generated';
                const languageSummary = item.translatedTo
                  ? `${sourceSummary} → ${languageLabel(item.translatedTo)}`
                  : sourceSummary;
                return (
                  <article key={item.id} className={`library-item-row${item.id === activeItemId ? ' active' : ''}`}>
                    <button
                      type="button"
                      className={`library-item ${item.status}${item.id === activeItemId ? ' active' : ''}`}
                      onClick={() => { selectLibraryItem(item); setLibraryOpen(false); }}
                    >
                      <Film size={16} />
                      <span className="library-item-name">{item.name}</span>
                      <small>
                        {item.status === 'processing' ? `${item.progress}% · ${item.stage}`
                          : item.status === 'done' ? 'Subtitles ready — click to watch'
                            : item.status === 'failed' ? `Failed: ${item.error}`
                              : 'Waiting — no subtitles yet'}
                      </small>
                      <span className="library-item-languages">{languageSummary}</span>
                      {item.status === 'processing' ? (
                        <span className="mini-progress"><span style={{ width: `${item.progress}%` }} /></span>
                      ) : null}
                    </button>
                    <div className="library-item-controls">
                      <button
                        type="button"
                        className="library-regenerate-button"
                        aria-label={`${item.cues?.length ? 'Regenerate' : 'Create'} subtitles for ${item.name}`}
                        title={itemBusy ? 'Available after subtitle processing finishes' : 'Choose the spoken language and generate subtitles again from the audio'}
                        disabled={itemBusy}
                        onClick={() => openRegenerationDialog(item)}
                      >
                        <RotateCcw size={15} />
                        <span>{item.cues?.length ? 'Regenerate' : 'Create'}</span>
                      </button>
                      <button
                        type="button"
                        className="library-delete-button"
                        aria-label={`Remove ${item.name} from library`}
                        title={itemBusy ? 'Available after subtitle processing finishes' : `Remove ${item.name} from library`}
                        disabled={itemBusy}
                        onClick={() => removeLibraryItem(item)}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </article>
                );
              }) : (
                <p className="library-empty">Nothing here yet. Use &quot;Add videos&quot; above, or drop files anywhere on the start screen.</p>
              )}
            </div>
            <div className="library-foot">
              <button
                type="button"
                className="secondary-action"
                title="Already have a matching .srt/.vtt/.ass subtitle file? Load it for the current video instead of transcribing."
                onClick={() => sidecarInputRef.current?.click()}
              >
                <FileText size={15} /><span>Import a subtitle file instead</span>
              </button>
            </div>
          </aside>
        </div>
      ) : null}

      {settingsOpen ? (
        <div className="settings-backdrop" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
          <aside className="settings-sheet" aria-label="Settings" onMouseDown={(event) => event.stopPropagation()}>
            <div className="settings-head">
              <div>
                <strong>Settings</strong>
                <span>{settingsTabs.find((tab) => tab.id === settingsTab)?.label}</span>
              </div>
              <button type="button" className="icon-button" aria-label="Close settings" onClick={() => setSettingsOpen(false)}><X size={18} /></button>
            </div>

            <div className="settings-tabs" role="tablist" aria-label="Settings sections">
              {settingsTabs.map((tab) => (
                <button key={tab.id} type="button" className={settingsTab === tab.id ? 'selected' : ''} onClick={() => setSettingsTab(tab.id)}>{tab.label}</button>
              ))}
            </div>

            <div className="settings-mode-row" aria-label="Experience">
              <span>Experience</span>
              <div className="mode-toggle">
                <button type="button" className={mode === 'education' ? 'selected' : ''} onClick={() => setMode('education')}>Study</button>
                <button type="button" className={mode === 'leisure' ? 'selected' : ''} onClick={() => setMode('leisure')}>Watch</button>
              </div>
            </div>

            <div className="settings-body">
              {settingsTab === 'languages' ? (
                <section className="settings-section">
                  <div className="config-language-grid">
                    <SelectControl label="Source" value={sourceLang} onChange={handleSourceLanguageChange} options={sourceLanguages} disabled={processing || transcribing || translationRunning} />
                    <SelectControl label="Target" value={targetLang} onChange={handleTargetLanguageChange} disabled={processing || transcribing || translationRunning} />
                  </div>
                  {sourceLang === 'detect' ? (
                    <p className="settings-note">
                      Auto-detect runs speech language recognition on the video&apos;s audio.
                      {detectedLang ? ` Last detected: ${sourceLangLabel(detectedLang)}.` : ''}
                    </p>
                  ) : null}
                  {transcribing ? <p className="settings-note">Transcribing audio from the imported file…</p> : null}
                  <div className="source-modes">
                    {sourceModes.map((item) => (
                      <button key={item.id} type="button" className={sourceMode === item.id ? 'selected' : ''} onClick={() => chooseSourceMode(item.id)}>{item.label}</button>
                    ))}
                  </div>
                  <p className="settings-note">Mixed-language detection follows the audio cleanup setting and stores per-cue source language metadata when available.</p>
                </section>
              ) : null}

              {settingsTab === 'subtitles' ? (
                <section className="settings-section">
                  <div className="subtitle-control-group wide">
                    {subtitleStyles.map((style) => (
                      <button key={style.id} type="button" className={subtitleStyle === style.id ? 'selected' : ''} onClick={() => setSubtitleStyle(style.id)}>{style.label}</button>
                    ))}
                  </div>
                  <div className="subtitle-control-group wide">
                    {subtitlePositions.map((position) => (
                      <button key={position.id} type="button" className={subtitlePosition === position.id ? 'selected' : ''} onClick={() => setSubtitlePosition(position.id)}>{position.label}</button>
                    ))}
                  </div>
                  <div className="subtitle-color-grid">
                    <div className="subtitle-color-field">
                      <div className="subtitle-color-heading">
                        <span>Spoken text</span>
                        <input
                          type="color"
                          aria-label="Spoken subtitle fill color"
                          value={subtitleOriginalColor}
                          onChange={(event) => setSubtitleOriginalColor(event.target.value)}
                        />
                      </div>
                      <div className="subtitle-swatch-row" aria-label="Spoken subtitle color presets">
                        {SUBTITLE_COLOR_PRESETS.map((color) => (
                          <button
                            key={`original-${color}`}
                            type="button"
                            className={subtitleOriginalColor === color ? 'selected' : ''}
                            style={{ '--swatch-color': color }}
                            aria-label={`Use ${color} for spoken subtitles`}
                            title={color}
                            onClick={() => setSubtitleOriginalColor(color)}
                          />
                        ))}
                      </div>
                    </div>
                    <div className="subtitle-color-field">
                      <div className="subtitle-color-heading">
                        <span>Translation</span>
                        <input
                          type="color"
                          aria-label="Translation subtitle fill color"
                          value={subtitleTranslationColor}
                          onChange={(event) => setSubtitleTranslationColor(event.target.value)}
                        />
                      </div>
                      <div className="subtitle-swatch-row" aria-label="Translation subtitle color presets">
                        {SUBTITLE_COLOR_PRESETS.map((color) => (
                          <button
                            key={`translation-${color}`}
                            type="button"
                            className={subtitleTranslationColor === color ? 'selected' : ''}
                            style={{ '--swatch-color': color }}
                            aria-label={`Use ${color} for translated subtitles`}
                            title={color}
                            onClick={() => setSubtitleTranslationColor(color)}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="subtitle-log-toolbar settings-subtitle-log">
                    <div>
                      <strong>Session subtitle log</strong>
                      <span>
                        {subtitleLog
                          ? `${subtitleLog.name} · ${subtitleLog.cueCount} cues · ${clockShort(subtitleLog.duration)}`
                          : 'Created after a cue set is ready'}
                      </span>
                    </div>
                    <div className="subtitle-log-actions">
                      <button type="button" className="icon-button" aria-label="Download temporary SRT log" title="Download temporary SRT log" disabled={!subtitleLog} onClick={downloadSubtitleLog}>
                        <Download size={16} />
                      </button>
                      <button type="button" className="icon-button" aria-label="Clear temporary subtitle log" title="Clear temporary subtitle log" disabled={!subtitleLog} onClick={clearSubtitleLog}>
                        <X size={16} />
                      </button>
                    </div>
                  </div>
                  <div className="mask-mode-grid">
                    {subtitleMaskModes.map((item) => (
                      <button key={item.id} type="button" className={maskMode === item.id ? 'selected' : ''} onClick={() => chooseMaskMode(item.id)}>
                        <strong>{item.label}</strong><small>{item.detail}</small>
                      </button>
                    ))}
                  </div>
                  <div className="mask-preset-row">
                    {maskPresets.map((preset) => (
                      <button key={preset.id} type="button" onClick={() => applyMaskPreset(preset)}>{preset.label}</button>
                    ))}
                    <button type="button" className={maskEditing ? 'selected' : ''} onClick={() => setMaskEditing((value) => !value)}>{maskEditing ? 'Editing on' : 'Edit region'}</button>
                  </div>
                </section>
              ) : null}

              {settingsTab === 'audio' ? (
                <section className="settings-section">
                  <div className={`pipeline-health ${whisperReady ? 'ready' : 'needs-repair'}`}>
                    <div>
                      <strong>Local transcription pipeline</strong>
                      <span>{whisperReady
                        ? (transcriptionStatus?.model?.downloadOnDemand
                          ? `FFmpeg, ffprobe, and local Whisper are ready. The ${qualityPresets[quality].label} model downloads on first transcription.`
                          : 'FFmpeg, ffprobe, local Whisper, and the selected model are ready.')
                        : `Local transcription needs FFmpeg, ffprobe, the local recognizer, and the ${qualityPresets[quality].label} tier model.`}</span>
                    </div>
                    <div className="pipeline-checks">
                      {['ffmpeg', 'ffprobe', 'recognizer', 'model'].map((key) => (
                        <span key={key} className={transcriptionStatus?.checks?.[key] ? 'ready' : 'missing'}>{key}</span>
                      ))}
                    </div>
                    <div className="pipeline-actions">
                      <button type="button" onClick={loadSampleProject}>Try sample</button>
                      <button
                        type="button"
                        onClick={async () => {
                          const status = await refreshTranscriptionStatus(quality);
                          setStatusMessage(status.ready
                            ? 'Local transcription is ready for the selected quality tier.'
                            : 'Reinstall the app dependencies, then use Re-check transcription.');
                        }}
                      >
                        Re-check transcription
                      </button>
                    </div>
                  </div>
                  <div className="preset-row">
                    {Object.entries(qualityPresets).map(([id, preset]) => (
                      <button key={id} type="button" className={quality === id ? 'selected' : ''} onClick={() => handleQualityChange(id)}>
                        <strong>{preset.label}</strong><small>{preset.detail}</small>
                      </button>
                    ))}
                  </div>
                  <div className="toggle-list">
                    {cleanupOptions.map((option) => (
                      <label key={option.id} className="toggle-row">
                        <input type="checkbox" checked={cleanup[option.id]} onChange={() => toggleCleanup(option.id)} />
                        <span><strong>{option.label}</strong><small>{option.detail}</small></span>
                      </label>
                    ))}
                  </div>
                </section>
              ) : null}

              {settingsTab === 'learning' ? (
                <section className="settings-section">
                  <div className="review-summary">
                    <strong>{savedCards.length}</strong>
                    <span>mined cards</span>
                    <strong>{dueCards}</strong>
                    <span>due now</span>
                  </div>
                  <div className="loop-tool-list">
                    {loopTools.map((tool) => (
                      <article key={tool.label}>
                        <strong>{tool.label}</strong>
                        <span>{tool.detail}</span>
                      </article>
                    ))}
                  </div>
                  <div className="learning-feature-list">
                    {studyFeatures.map((feature) => (
                      <article key={feature.label}>
                        <strong>{feature.label}</strong>
                        <span>{feature.detail}</span>
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}

              {settingsTab === 'export' ? (
                <section className="settings-section">
                  <div className="export-options sheet-options">
                    {exportFormats.map((format) => (
                      <button key={format.id} type="button" className={formats[format.id] ? 'selected' : ''} onClick={() => toggleFormat(format.id)}>
                        <span>{format.label}</span><small>{format.detail}</small>
                      </button>
                    ))}
                  </div>
                  <button className="export-button full" type="button" disabled={!translationDone || translationRunning} onClick={exportSelected}><Download size={18} /><span>Export selected files</span></button>
                </section>
              ) : null}

              {settingsTab === 'batch' ? (
                <section className="settings-section">
                  <div className="metric-grid">
                    <label><span>Batch size</span><input type="number" min="5" max="100" value={batchSize} onChange={(event) => setBatchSize(Number(event.target.value) || 50)} /></label>
                    <label><span>Concurrency</span><input type="number" min="1" max="12" value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value) || 1)} /></label>
                  </div>
                  <div className="queue-summary">
                    <span>{queueStats.done} done</span><span>{queueStats.running} running</span><span>{queueStats.queued} queued</span><strong>{queueStats.overall}%</strong>
                  </div>
                  <div className="queue-actions">
                    <button type="button" onClick={startQueue}><Play size={15} /> Start</button>
                    <button type="button" onClick={cancelQueue}><Pause size={15} /> Pause</button>
                    <button type="button" onClick={() => batchInputRef.current?.click()}><FileJson size={15} /> Import</button>
                  </div>
                </section>
              ) : null}

              {settingsTab === 'advanced' ? (
                <section className="settings-section">
                  <label className="toggle-row single">
                    <input type="checkbox" checked={cacheEnabled} onChange={() => setCacheEnabled((value) => !value)} />
                    <span><strong>Content-hash cache</strong><small>Skip repeated translations and completed jobs.</small></span>
                  </label>
                  <div className="performance-note">
                    <FastForward size={16} />
                    <span>Logs: ~/.lingoloop/logs · Models: ~/.lingoloop/models · Mask: {maskSettings.exportFilter}</span>
                  </div>
                </section>
              ) : null}
            </div>
          </aside>
        </div>
      ) : null}

      <LanguageChangeDialog
        change={pendingLanguageChange}
        cueCount={cues.length}
        onCancel={cancelLanguageChange}
        onConfirm={confirmLanguageChange}
      />
      <RegenerateDialog
        request={regenerationRequest}
        item={library.find((entry) => entry.id === regenerationRequest?.itemId)}
        busy={regenerationRunning}
        onChange={(patch) => setRegenerationRequest((current) => current ? { ...current, ...patch } : current)}
        onCancel={() => setRegenerationRequest(null)}
        onConfirm={confirmLibraryRegeneration}
      />
    </main>
  );
}
