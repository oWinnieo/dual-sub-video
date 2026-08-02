'use client';

/**
 * The supported transcription engine:
 *
 *   1. 'node-whisper'  — LOCAL Node-side Whisper via the /api/transcribe route.
 *                        FFmpeg prepares real media and the selected model is
 *                        cached locally after its first download.
 *
 * The legacy browser-side Transformers.js implementation remains in
 * src/lib/transcribe.js for reference, but it is deliberately not a production
 * fallback: it cannot reliably decode real-world MP4/MKV audio and its Node
 * shims are incompatible with this Next.js client bundle.
 */

// Send the imported media to the local Node-side Whisper backend. In Electron we use
// the original desktop path; in a normal browser we upload the File as a
// bridge to the same local route.
async function readStreamingTranscription(res, { onProgress, onSegment }) {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('The local transcription stream could not be opened.');
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = null;

  const handleLine = async (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'error') {
      const error = new Error(event.error || 'Local transcription failed.');
      error.code = event.code || null;
      error.job = event.job || null;
      throw error;
    }
    if (event.type === 'segment-start') {
      const fraction = event.durationSeconds ? event.start / event.durationSeconds : 0;
      onProgress?.(Math.min(0.99, fraction), `Extracting segment ${event.index + 1} of ${event.totalSegments}`, event);
    } else if (event.type === 'segment-progress') {
      const withinSegment = event.totalWindows ? event.windowIndex / event.totalWindows : 0;
      const mediaTime = event.start + ((event.end - event.start) * withinSegment);
      const fraction = event.durationSeconds ? mediaTime / event.durationSeconds : withinSegment;
      onProgress?.(Math.min(0.99, fraction), `Transcribing segment ${event.index + 1} of ${event.totalSegments}`, event);
    } else if (event.type === 'segment') {
      await onSegment?.(event);
      const fraction = event.durationSeconds ? event.end / event.durationSeconds : 1;
      onProgress?.(Math.min(0.99, fraction), `Segment ${event.index + 1} of ${event.totalSegments} ready`, event);
    } else if (event.type === 'complete') {
      completed = event;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) await handleLine(line);
    if (done) break;
  }
  if (buffer.trim()) await handleLine(buffer);
  if (!completed) throw new Error('The local transcription stream ended before completion.');
  return completed;
}

async function transcribeWithLocalEngine(file, {
  language,
  quality,
  mediaPath,
  samplePath,
  progressive,
  signal,
  onProgress,
  onSegment,
}) {
  const lang = language === 'detect' ? 'auto' : language;
  let request;
  console.log('[Transcription] Request started', {
    language: lang,
    quality,
    source: mediaPath ? 'desktop-path' : samplePath ? 'sample' : file ? 'browser-upload' : 'missing',
    fileName: file?.name || (mediaPath ? mediaPath.split(/[\\/]/).pop() : samplePath || null),
  });

  if (mediaPath || samplePath) {
    onProgress?.(progressive ? 0.01 : 0.08, mediaPath ? 'Sending desktop path to local engine' : 'Running sample smoke test');
    request = fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: mediaPath, samplePath, language: lang, quality, stream: progressive }),
      signal,
    });
  } else if (file) {
    onProgress?.(progressive ? 0.01 : 0.08, 'Uploading audio to local engine');
    const form = new FormData();
    form.append('file', file);
    form.append('language', lang);
    form.append('quality', quality);
    if (progressive) form.append('stream', '1');
    request = fetch('/api/transcribe', { method: 'POST', body: form, signal });
  } else {
    throw new Error('No media file or sample path was provided for local transcription.');
  }

  // The server can't stream progress for a single local recognition run, so tick a
  // soft heartbeat while we wait — otherwise long jobs look frozen.
  let heartbeat = progressive ? 0.01 : 0.1;
  const ticker = setInterval(() => {
    heartbeat = Math.min(progressive ? 0.02 : 0.8, heartbeat + (progressive ? 0.002 : 0.02));
    onProgress?.(heartbeat, progressive ? 'Uploading media to local engine' : 'Transcribing with local Whisper');
  }, 2000);

  let res;
  try {
    res = await request;
  } finally {
    clearInterval(ticker);
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    console.error('[Transcription] Failed', {
      status: res.status,
      code: data.code || null,
      message: data.error || `Local transcription failed (${res.status}).`,
      rejectedHallucinations: data.rejectedHallucinations || 0,
      job: data.job || null,
    });
    const err = new Error(data.error || `Local transcription failed (${res.status}).`);
    err.code = data.code || null;
    err.status = res.status;
    err.job = data.job || null;
    err.statusInfo = data.status || null;
    throw err;
  }
  if (!progressive) onProgress?.(0.85, 'Reading cues');
  const data = progressive
    ? await readStreamingTranscription(res, { onProgress, onSegment })
    : await res.json();
  console.log('[Transcription] Completed', {
    detectedLanguage: data.detectedLanguage || null,
    effectiveQuality: data.effectiveQuality || quality,
    autoUpgraded: Boolean(data.autoUpgraded),
    languageConfidence: data.languageDetection?.confidence || 0,
    recoveredCueCount: data.recoveredCueCount || 0,
    attemptedGapRecoveries: data.attemptedGapRecoveries || 0,
    cueCount: data.cues?.length || 0,
  });
  return {
    cues: data.cues || [],
    detectedLanguage: data.detectedLanguage || null,
    effectiveQuality: data.effectiveQuality || quality,
    autoUpgraded: Boolean(data.autoUpgraded),
    languageDetection: data.languageDetection || null,
    recoveredCueCount: data.recoveredCueCount || 0,
    attemptedGapRecoveries: data.attemptedGapRecoveries || 0,
    engine: 'node-whisper',
    logPath: data.logPath || null,
    status: data.status || null,
    job: data.job || null,
  };
}

/**
 * Transcribe a media File with the chosen engine.
 * Local Node-side Whisper is intentionally the only supported production path.
 *
 * @param {File|null} file
 * @param {{engine?:string, language?:string, quality?:string,
 *          mediaPath?:string, samplePath?:string, progressive?:boolean, signal?:AbortSignal,
 *          onProgress?:(fraction:number, stage:string)=>void,
 *          onSegment?:(segment:object)=>void|Promise<void>,
 *          onEngine?:(engineId:string)=>void}} options
 */
export async function transcribeVideo(file, options = {}) {
  const {
    engine = 'node-whisper',
    language = 'detect',
    quality = 'balanced',
    mediaPath = '',
    samplePath = '',
    progressive = false,
    signal,
    onProgress,
    onSegment,
    onEngine,
  } = options;

  if (engine !== 'node-whisper') {
    const error = new Error('In-browser transcription is disabled for imported media. Use the local server-side Whisper engine to process MP4 files reliably.');
    error.code = 'UNSUPPORTED_ENGINE';
    throw error;
  }

  onEngine?.('node-whisper');
  return transcribeWithLocalEngine(file, {
    language,
    quality,
    mediaPath,
    samplePath,
    progressive,
    signal,
    onProgress,
    onSegment,
  });
}
