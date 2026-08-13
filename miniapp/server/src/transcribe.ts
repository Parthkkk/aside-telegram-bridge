/**
 * On-device speech-to-text.
 *
 * Audio arrives as whatever the phone's MediaRecorder produced (webm/opus on
 * Android Chrome, mp4/aac on iOS Safari), gets normalised by ffmpeg to the
 * 16 kHz mono PCM whisper.cpp requires, and is decoded locally by whisper-cli.
 *
 * Nothing leaves the Mac. No API key, no per-minute billing, no third party
 * holding the recordings. On an M1 the large-v3-turbo q5 model decodes the
 * 11-second JFK sample in roughly 4 seconds wall clock, so a normal spoken
 * message comes back faster than it took to say.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_FFMPEG = '/opt/homebrew/bin/ffmpeg';
export const DEFAULT_WHISPER = '/opt/homebrew/bin/whisper-cli';

/** Decode ceiling. A wedged child must never pin the box indefinitely. */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** ~25 MB of compressed opus is far more speech than a composer ever needs. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export interface TranscribeOptions {
  modelPath: string;
  ffmpegPath?: string;
  whisperPath?: string;
  timeoutMs?: number;
  /** whisper.cpp thread count. The M1's 4 performance cores are the sweet spot. */
  threads?: number;
  /** ISO-639-1, or 'auto' to let the model decide. */
  language?: string;
}

export type TranscribeFailure =
  | 'empty_audio'
  | 'audio_too_large'
  | 'model_missing'
  | 'ffmpeg_missing'
  | 'whisper_missing'
  | 'decode_failed'
  | 'timeout';

export class TranscribeError extends Error {
  constructor(readonly code: TranscribeFailure, message?: string) {
    super(message || code);
    this.name = 'TranscribeError';
  }
}

/**
 * whisper.cpp is chatty in ways that are useless inside a text box.
 *
 * Even under `-nt` some builds still emit bracketed timestamps, and on silence
 * every Whisper model reproduces boilerplate from its training set: subtitle
 * credits, "thanks for watching", bracketed sound tags. A composer that
 * silently fills itself with "[BLANK_AUDIO]" reads as a broken app, so those
 * are dropped rather than shown.
 */
export function cleanTranscript(raw: string): string {
  const NOISE =
    /^(blank_audio|inaudible|silence|music|applause|laughter|no speech|speaking in foreign language|thanks? for watching[.!]?|subs by .*|subtitles by .*|transcription by .*)$/i;

  return raw
    .split('\n')
    .map((line) =>
      // Leading "[00:00:00.000 --> 00:00:04.000]" style stamps.
      line.replace(/^\s*\[[\d:.,\s\->]+\]\s*/, '').trim(),
    )
    .filter(Boolean)
    .filter((line) => {
      const bare = line.replace(/[[\]()*]/g, '').trim();
      return bare.length > 0 && !NOISE.test(bare);
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function runChild(
  bin: string,
  args: string[],
  timeoutMs: number,
  missingCode: TranscribeFailure,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        if (!err) return resolve(String(stdout));
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.code === 'ENOENT') {
          return reject(new TranscribeError(missingCode, `${bin} not found`));
        }
        if (e.killed) {
          return reject(new TranscribeError('timeout', `${bin} timed out`));
        }
        return reject(
          new TranscribeError(
            'decode_failed',
            `${path.basename(bin)}: ${String(stderr || err.message).slice(0, 400)}`,
          ),
        );
      },
    );
  });
}

/**
 * Transcribe one recording.
 *
 * Everything happens inside a per-call temp directory that is removed in a
 * `finally`, so a failed decode cannot leave audio lying around on disk.
 */
export async function transcribeAudio(
  audio: Buffer,
  opts: TranscribeOptions,
): Promise<{ text: string; ms: number }> {
  const started = Date.now();

  if (!audio || audio.length === 0) throw new TranscribeError('empty_audio');
  if (audio.length > MAX_AUDIO_BYTES) throw new TranscribeError('audio_too_large');
  if (!fs.existsSync(opts.modelPath)) {
    throw new TranscribeError('model_missing', `model not at ${opts.modelPath}`);
  }

  const ffmpeg = opts.ffmpegPath || DEFAULT_FFMPEG;
  const whisper = opts.whisperPath || DEFAULT_WHISPER;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-stt-'));
  const inPath = path.join(dir, `in-${crypto.randomBytes(4).toString('hex')}`);
  const wavPath = path.join(dir, 'audio.wav');

  try {
    fs.writeFileSync(inPath, audio);

    // Container-agnostic on purpose: ffmpeg sniffs the real format, so the
    // same path handles Android's webm/opus and iOS's mp4/aac without the
    // client having to tell us which one it picked.
    await runChild(
      ffmpeg,
      [
        '-hide_banner', '-loglevel', 'error',
        '-i', inPath,
        '-ar', '16000',      // whisper.cpp only accepts 16 kHz
        '-ac', '1',          // mono
        '-c:a', 'pcm_s16le',
        // Trim dead air at both ends. Silence is where Whisper hallucinates,
        // and it is also the most expensive thing to decode per word returned.
        '-af', 'silenceremove=start_periods=1:start_silence=0.15:start_threshold=-45dB:detection=peak,areverse,silenceremove=start_periods=1:start_silence=0.15:start_threshold=-45dB:detection=peak,areverse',
        '-y', wavPath,
      ],
      timeoutMs,
      'ffmpeg_missing',
    );

    if (!fs.existsSync(wavPath) || fs.statSync(wavPath).size < 2048) {
      // Under ~64 ms of PCM. The user tapped and released, there is no speech.
      return { text: '', ms: Date.now() - started };
    }

    const args = [
      '-m', opts.modelPath,
      '-f', wavPath,
      '-nt',                                    // no timestamps
      '-np',                                    // no progress chrome
      '-t', String(opts.threads ?? 4),          // M1 performance cores
      '--best-of', '3',
      '--beam-size', '3',
      // Suppress the "[BLANK_AUDIO]"-class tokens at the source as well as in
      // cleanTranscript, since belt-and-braces is cheaper than a bad paste.
      '--suppress-nst',
    ];
    if (opts.language && opts.language !== 'auto') {
      args.push('-l', opts.language);
    }

    const stdout = await runChild(whisper, args, timeoutMs, 'whisper_missing');
    return { text: cleanTranscript(stdout), ms: Date.now() - started };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
