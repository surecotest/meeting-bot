import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// --- Recording / audio constants ---

export const RECORDINGS_DIR = path.join(process.cwd(), 'recordings');
export const RECORD_INTERVAL_MS = 60 * 1000; // 1 minute
export const OUTPUT_SAMPLE_RATE = parseInt(process.env.OUTPUT_SAMPLE_RATE) || 16000;
export const OUTPUT_BIT_DEPTH = 16;

// Canonical G.711 μ-law decode table (256 entries).
// Twilio Media Streams provides audio as 8kHz μ-law (8-bit) in base64.
const MULAW_DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = (~i) & 0xff;
  const sign = (u & 0x80) ? -1 : 1;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  MULAW_DECODE_TABLE[i] = sign * sample;
}

export function ensureRecordingsDir() {
  try {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  } catch (_) {}
}

/** G.711 μ-law expand to 16-bit PCM (little-endian) */
export function mulawToPcm(mulawBuf) {
  const out = Buffer.allocUnsafe(mulawBuf.length * 2);
  for (let i = 0; i < mulawBuf.length; i++) {
    out.writeInt16LE(MULAW_DECODE_TABLE[mulawBuf[i]], i * 2);
  }
  return out;
}

/** G.711 μ-law compress: 16-bit PCM (little-endian) → μ-law */
export function pcmToMulaw(pcmBuf) {
  const MULAW_BIAS = 0x84;
  const MULAW_MAX = 32635; // 0x7f7b
  const clamp16 = (x) => Math.max(-32768, Math.min(32767, x));
  const out = Buffer.alloc(pcmBuf.length / 2);
  for (let i = 0; i < out.length; i++) {
    let sample = clamp16(pcmBuf.readInt16LE(i * 2));
    const sign = (sample >>> 15) & 0x01;
    if (sample < 0) sample = -sample;
    if (sample > MULAW_MAX) sample = MULAW_MAX;
    sample += MULAW_BIAS;
    let exponent = 7;
    for (let exp = 0; exp < 8; exp++) {
      if (sample <= (0x1f << (exp + 2))) {
        exponent = exp;
        break;
      }
    }
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    let mulaw = (sign << 7) | (exponent << 4) | mantissa;
    out[i] = ~mulaw;
  }
  return out;
}

/**
 * Write a mono μ-law WAV file (WAVE_FORMAT_MULAW, 8-bit samples).
 *
 * This preserves the exact bytes received from Twilio Media Streams
 * (`audio/x-mulaw` @ 8kHz), without decoding to PCM.
 */
export function writeMulawWavFile(filepath, mulawBuffer, sampleRate = 8000) {
  const numChannels = 1;
  const bitsPerSample = 8;
  const audioFormat = 7; // WAVE_FORMAT_MULAW

  const dataSize = mulawBuffer.length;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const sampleLength = dataSize; // 1 byte per sample @ 8kHz mono

  // WAV header with:
  // - fmt  (18 bytes for non-PCM, cbSize=0)
  // - fact (required for non-PCM; 4-byte sample length)
  // - data
  const header = Buffer.alloc(58);
  header.write('RIFF', 0);
  header.writeUInt32LE(58 - 8 + dataSize, 4); // fileSize - 8
  header.write('WAVE', 8);

  // fmt chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(18, 16); // fmt chunk size
  header.writeUInt16LE(audioFormat, 20); // WAVE_FORMAT_MULAW
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.writeUInt16LE(0, 36); // cbSize

  // fact chunk
  header.write('fact', 38);
  header.writeUInt32LE(4, 42);
  header.writeUInt32LE(sampleLength, 46);

  // data chunk
  header.write('data', 50);
  header.writeUInt32LE(dataSize, 54);

  fs.writeFileSync(filepath, Buffer.concat([header, mulawBuffer]));
}

/**
 * Resample raw 16-bit PCM (little-endian) using linear interpolation.
 *
 * Assumes mono audio. For best results, pass properly aligned buffers
 * (byteLength multiple of 2).
 */
export function resamplePcm16(pcmBuffer, fromRate, toRate) {
  if (!Buffer.isBuffer(pcmBuffer)) {
    throw new TypeError('resamplePcm16: pcmBuffer must be a Buffer');
  }
  if (fromRate === toRate) return pcmBuffer;
  if (pcmBuffer.length === 0) return pcmBuffer;
  if (pcmBuffer.length % 2 !== 0) {
    // Drop trailing byte (shouldn't happen for int16 PCM)
    pcmBuffer = pcmBuffer.subarray(0, pcmBuffer.length - 1);
  }

  const ratio = toRate / fromRate;
  const inputSamples = pcmBuffer.length / 2;
  const outputSamples = Math.max(0, Math.floor(inputSamples * ratio));
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const srcIndex = i / ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, inputSamples - 1);
    const t = srcIndex - srcIndexFloor;

    const sample1 = pcmBuffer.readInt16LE(srcIndexFloor * 2);
    const sample2 = pcmBuffer.readInt16LE(srcIndexCeil * 2);
    const interpolated = Math.round(sample1 + (sample2 - sample1) * t);
    output.writeInt16LE(interpolated, i * 2);
  }

  return output;
}

/** Generate TTS audio "Hi Thank you" and return as μ-law 8kHz buffer */
let cachedAudio = null;
export function generateTtsAudio() {
  if (cachedAudio) return cachedAudio;

  const tempDir = path.join(process.cwd(), 'temp');
  try {
    fs.mkdirSync(tempDir, { recursive: true });
  } catch (_) {}

  const tempAiff = path.join(tempDir, 'tts_temp.aiff');
  const temp8k = path.join(tempDir, 'tts_8k.pcm');

  try {
    let sayCmd = `say -v Samantha "Hi Thank you" -o "${tempAiff}"`;
    try {
      execSync(sayCmd, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      sayCmd = `say "Hi Thank you" -o "${tempAiff}"`;
      execSync(sayCmd, { stdio: ['ignore', 'ignore', 'pipe'] });
    }

    if (!fs.existsSync(tempAiff)) {
      throw new Error('say command did not create output file');
    }

    try {
      // Force raw PCM16LE mono @ 8kHz (avoid WAV headers / float formats / extra chunks)
      execSync(`ffmpeg -y -i "${tempAiff}" -f s16le -ar 8000 -ac 1 "${temp8k}"`, {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (ffmpegErr) {
      try {
        // Equivalent raw PCM16LE mono @ 8kHz with sox
        execSync(`sox "${tempAiff}" -t raw -r 8000 -c 1 -e signed-integer -b 16 -L "${temp8k}"`, {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
      } catch (soxErr) {
        throw new Error(
          `Audio conversion failed. ffmpeg error: ${ffmpegErr.message}, sox error: ${soxErr.message}`
        );
      }
    }

    if (!fs.existsSync(temp8k)) {
      throw new Error('Audio conversion did not create output file');
    }

    const pcmData = fs.readFileSync(temp8k);
    if (pcmData.length === 0) {
      throw new Error('PCM file has no audio data');
    }
    const mulaw = pcmToMulaw(pcmData);

    try {
      fs.unlinkSync(tempAiff);
    } catch (_) {}
    try {
      fs.unlinkSync(temp8k);
    } catch (_) {}

    cachedAudio = mulaw;
    console.log('[tts] Generated audio:', mulaw.length, 'bytes μ-law');
    return mulaw;
  } catch (e) {
    console.error('[tts] Error generating audio:', e.message);
    console.log('[tts] Using silence fallback');
    return Buffer.alloc(8000, 0x7f);
  }
}

/** Write a mono PCM16 WAV file (no enhancement, no resampling). */
export function writeWavFile(filepath, pcmBuffer, sampleRate = 8000) {
  const numChannels = 1;
  const bitsPerSample = OUTPUT_BIT_DEPTH;

  // Ensure int16 alignment
  let processedPcm = pcmBuffer;
  if (processedPcm.length % 2 !== 0) {
    processedPcm = processedPcm.subarray(0, processedPcm.length - 1);
  }

  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = processedPcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  fs.writeFileSync(filepath, Buffer.concat([header, processedPcm]));
}
