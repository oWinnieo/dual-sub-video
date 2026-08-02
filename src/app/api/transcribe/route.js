import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { createWriteStream, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { runWhisperJob, getWhisperStatus, lingoloopPaths } from '@/lib/local-transcription';

// This route uses bundled FFmpeg plus the Node-side Whisper model, so it must
// run on the Node.js runtime, never the Edge runtime.
export const runtime = 'nodejs';
export const maxDuration = 600;

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const STREAM_FIRST_SEGMENT_SECONDS = 2 * 60;
const STREAM_SEGMENT_SECONDS = 3 * 60;

// GET -> pipeline health (used by the UI's "Repair transcription" check).
export async function GET(request) {
  const quality = new URL(request.url).searchParams.get('quality') || 'fast';
  return NextResponse.json(getWhisperStatus(quality));
}

function sanitizeName(name) {
  return (name || 'input.mp4').replace(/[^\w.\-]+/g, '_').slice(-120) || 'input.mp4';
}

async function writeUploadToTemp(file) {
  const { tempDir } = lingoloopPaths();
  const root = tempDir || os.tmpdir();
  await fs.mkdir(root, { recursive: true });
  if (file.size > MAX_UPLOAD_BYTES) {
    const sizeGb = (MAX_UPLOAD_BYTES / 1024 / 1024 / 1024).toFixed(0);
    throw new Error(`Upload is too large for browser transcription. Use the desktop file path flow for files over ${sizeGb} GB.`);
  }
  const dir = await fs.mkdtemp(path.join(root, 'upload-'));
  const dest = path.join(dir, sanitizeName(file.name));
  await pipeline(Readable.fromWeb(file.stream()), createWriteStream(dest));
  return { dir, dest };
}

function resolveSamplePath(samplePath) {
  const sampleRoot = path.resolve(process.cwd(), 'public', 'samples');
  const requested = String(samplePath || 'sample.mp4')
    .replace(/^\/+/, '')
    .replace(/^samples\/+/, '');
  const resolved = path.resolve(sampleRoot, requested);
  if (resolved !== sampleRoot && !resolved.startsWith(`${sampleRoot}${path.sep}`)) {
    throw new Error('Sample path must stay inside public/samples.');
  }
  return resolved;
}

function streamTranscription({ mediaPath, language, quality, job, status, cleanupDir, signal }) {
  const encoder = new TextEncoder();
  const send = (controller, event) => {
    if (signal?.aborted) return false;
    try {
      controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      return true;
    } catch {
      return false;
    }
  };

  const stream = new ReadableStream({
    start(controller) {
      void (async () => {
        try {
          const result = await runWhisperJob({
            mediaPath,
            language,
            quality,
            jobId: job.id,
            segmentSeconds: STREAM_SEGMENT_SECONDS,
            firstSegmentSeconds: STREAM_FIRST_SEGMENT_SECONDS,
            signal,
            onProgress: (progress) => send(controller, progress),
            onSegment: (segment) => send(controller, { type: 'segment', ...segment }),
          });
          send(controller, {
            type: 'complete',
            cues: result.cues,
            detectedLanguage: result.detectedLanguage,
            effectiveQuality: result.effectiveQuality,
            autoUpgraded: result.autoUpgraded,
            languageDetection: result.languageDetection,
            recoveredCueCount: result.recoveredCueCount,
            attemptedGapRecoveries: result.attemptedGapRecoveries,
            rejectedHallucinations: result.rejectedHallucinations,
            durationSeconds: result.durationSeconds,
            segmentSeconds: result.segmentSeconds,
            firstSegmentSeconds: result.firstSegmentSeconds,
            totalSegments: result.totalSegments,
            engine: 'node-whisper',
            status,
            logPath: result.plan.logPath,
            job: { ...job, stage: 'complete', logPath: result.plan.logPath, stages: result.stages },
          });
        } catch (error) {
          send(controller, {
            type: 'error',
            error: error?.message || 'Transcription failed.',
            code: error?.code || 'TRANSCRIPTION_FAILED',
            job: {
              ...job,
              stage: error?.stage || job.stage,
              logPath: error?.logPath || job.logPath,
              id: error?.jobId || job.id,
            },
          });
        } finally {
          if (cleanupDir) await fs.rm(cleanupDir, { recursive: true, force: true }).catch(() => {});
          try {
            controller.close();
          } catch {
            // The browser may have cancelled the stream after a completed segment.
          }
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function POST(request) {
  const contentType = request.headers.get('content-type') || '';
  let cleanupDir = null;
  const jobId = `transcribe-${Date.now()}-${randomUUID().slice(0, 8)}`;
  let job = {
    id: jobId,
    source: 'unknown',
    fileName: null,
    bytes: null,
    stage: 'received',
    logPath: null,
  };

  try {
    let mediaPath = null;
    let language = 'auto';
    let quality = 'fast';
    let streamRequested = false;

    if (contentType.includes('multipart/form-data')) {
      // Browser path (next dev / web): the video is uploaded as a File.
      const form = await request.formData();
      const file = form.get('file');
      if (!file || typeof file === 'string') {
        return NextResponse.json({ error: 'No video file was uploaded.' }, { status: 400 });
      }
      language = form.get('language') || 'auto';
      quality = form.get('quality') || 'fast';
      streamRequested = form.get('stream') === '1';
      job = {
        ...job,
        source: 'browser-upload',
        fileName: sanitizeName(file.name),
        bytes: Number(file.size) || 0,
        stage: 'writing-upload',
      };
      const written = await writeUploadToTemp(file);
      mediaPath = written.dest;
      cleanupDir = written.dir;
    } else {
      // Desktop path (Electron): pass an absolute file path or the bundled sample.
      const body = await request.json().catch(() => ({}));
      language = body.language || 'auto';
      quality = body.quality || 'fast';
      streamRequested = body.stream === true;
      if (body.path) {
        mediaPath = body.path;
        job = { ...job, source: 'desktop-path', fileName: path.basename(mediaPath), stage: 'validating-media' };
      } else if (body.samplePath) {
        mediaPath = resolveSamplePath(body.samplePath);
        job = { ...job, source: 'sample-path', fileName: path.basename(mediaPath), stage: 'validating-media' };
      }
      if (!mediaPath) {
        return NextResponse.json({ error: 'Provide an uploaded file, a "path", or a "samplePath".', job }, { status: 400 });
      }
      try {
        await fs.access(mediaPath);
      } catch {
        const code = body.samplePath ? 'NO_SAMPLE' : 'NO_MEDIA';
        return NextResponse.json({ error: `Media file was not found: ${mediaPath}`, code, job }, { status: 404 });
      }
    }

    // Fail fast with an actionable, typed error if local media handling is unavailable.
    const status = getWhisperStatus(quality);
    if (!status.ready) {
      const checks = status?.checks && typeof status.checks === 'object' ? status.checks : {};
      const missing = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
      return NextResponse.json(
        {
          error: `Local transcription is unavailable for the ${quality} tier. Missing: ${missing.join(', ')}.`,
          code: missing.includes('model') ? 'NO_MODEL' : 'NO_RECOGNIZER',
          status,
          job: { ...job, stage: 'preflight', checks },
        },
        { status: 503 },
      );
    }

    job = { ...job, stage: 'local-pipeline', logPath: path.join(status.paths.logsDir, `${jobId}.log`) };
    if (streamRequested) {
      const ownedCleanupDir = cleanupDir;
      cleanupDir = null;
      return streamTranscription({
        mediaPath,
        language,
        quality,
        job,
        status,
        cleanupDir: ownedCleanupDir,
        signal: request.signal,
      });
    }
    const {
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
    } = await runWhisperJob({ mediaPath, language, quality, jobId });
    job = { ...job, stage: 'parsing-cues', logPath: plan.logPath, stages };

    if (!cues.length) {
      const hallucinationOnly = rejectedHallucinations > 0;
      return NextResponse.json(
        {
          error: hallucinationOnly
            ? `Whisper produced only repetitive text (${rejectedHallucinations} cue${rejectedHallucinations === 1 ? '' : 's'} rejected). Choose the spoken language explicitly or check whether the clip contains clear speech.`
            : 'No speech was detected in this file. Check the audio track or try a different source.',
          code: hallucinationOnly ? 'ASR_HALLUCINATION' : 'NO_SPEECH',
          rejectedHallucinations,
          job,
        },
        { status: 422 },
      );
    }

    return NextResponse.json({
      cues,
      detectedLanguage,
      effectiveQuality,
      autoUpgraded,
      languageDetection,
      recoveredCueCount,
      attemptedGapRecoveries,
      rejectedHallucinations,
      engine: 'node-whisper',
      status,
      logPath: plan.logPath,
      job: { ...job, stage: 'complete' },
    });
  } catch (error) {
    console.error('[Transcribe API Error]:', error);
    return NextResponse.json(
      {
        error: error?.message || 'Transcription failed.',
        code: error?.code || 'TRANSCRIPTION_FAILED',
        job: {
          ...job,
          stage: error?.stage || job.stage,
          logPath: error?.logPath || job.logPath,
          id: error?.jobId || job.id,
        },
      },
      { status: 500 },
    );
  } finally {
    if (cleanupDir) fs.rm(cleanupDir, { recursive: true, force: true }).catch(() => {});
  }
}
