import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// --- Recording / audio constants ---

export const RECORDINGS_DIR = path.join(process.cwd(), 'recordings');
export const RECORD_INTERVAL_MS = 60 * 1000; // 1 minute
export const OUTPUT_SAMPLE_RATE = parseInt(process.env.OUTPUT_SAMPLE_RATE) || 16000;
export const OUTPUT_BIT_DEPTH = 16;

export function ensureRecordingsDir() {
  try {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  } catch (_) {}
}

/** G.711 μ-law expand to 16-bit PCM (little-endian) */
export function mulawToPcm(mulawBuf) {
  const MULAW_BIAS = 0x84;
  const out = Buffer.alloc(mulawBuf.length * 2);
  for (let i = 0; i < mulawBuf.length; i++) {
    let u = ~mulawBuf[i];
    const sign = (u & 0x80) ? -1 : 1;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
    sample -= MULAW_BIAS << exponent;
    if (exponent === 0) sample -= 0xff;
    sample = Math.max(-0x7f7b, Math.min(0x7f7b, sign * sample));
    out.writeInt16LE(sample, i * 2);
  }
  return out;
}

/** G.711 μ-law compress: 16-bit PCM (little-endian) → μ-law */
export function pcmToMulaw(pcmBuf) {
  const MULAW_BIAS = 0x84;
  const MULAW_MAX = 32635; // 0x7f7b
  const out = Buffer.alloc(pcmBuf.length / 2);
  for (let i = 0; i < out.length; i++) {
    let sample = pcmBuf.readInt16LE(i * 2);
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

/** Upsample PCM audio using linear interpolation */
function upsamplePcm(pcmBuffer, fromRate, toRate) {
  if (fromRate === toRate) return pcmBuffer;

  const ratio = toRate / fromRate;
  const inputSamples = pcmBuffer.length / 2;
  const outputSamples = Math.floor(inputSamples * ratio);
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

/** Apply noise reduction: noise gate, smoothing, and normalization */
function enhanceAudio(pcmBuffer) {
  const samples = pcmBuffer.length / 2;
  const NOISE_GATE_THRESHOLD = 500;
  const SMOOTHING_WINDOW = 3;
  const NOISE_REDUCTION_FACTOR = 0.3;

  let sumSquared = 0;
  let peakAmplitude = 0;

  for (let i = 0; i < samples; i++) {
    const sample = pcmBuffer.readInt16LE(i * 2);
    const absSample = Math.abs(sample);
    sumSquared += sample * sample;
    if (absSample > peakAmplitude) peakAmplitude = absSample;
  }

  const rms = Math.sqrt(sumSquared / samples);
  const noiseFloor = rms * 0.1;

  const output = Buffer.alloc(pcmBuffer.length);
  const window = [];

  for (let i = 0; i < samples; i++) {
    let sample = pcmBuffer.readInt16LE(i * 2);
    const absSample = Math.abs(sample);

    if (absSample < NOISE_GATE_THRESHOLD) {
      sample = 0;
    } else {
      const noiseReduction = Math.max(0, absSample - noiseFloor * NOISE_REDUCTION_FACTOR);
      sample = sample > 0 ? noiseReduction : -noiseReduction;
    }

    window.push(sample);
    if (window.length > SMOOTHING_WINDOW) {
      window.shift();
    }

    const smoothed = window.reduce((sum, s) => sum + s, 0) / window.length;
    sample = Math.round(smoothed);
    sample = Math.max(-32767, Math.min(32767, sample));

    output.writeInt16LE(sample, i * 2);
  }

  if (peakAmplitude > 100) {
    const normalizeFactor = (32767 * 0.85) / peakAmplitude;
    for (let i = 0; i < samples; i++) {
      let sample = output.readInt16LE(i * 2);
      sample = Math.round(sample * normalizeFactor);
      sample = Math.max(-32767, Math.min(32767, sample));
      output.writeInt16LE(sample, i * 2);
    }
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
  const temp8k = path.join(tempDir, 'tts_8k.wav');

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
      execSync(`ffmpeg -i "${tempAiff}" -ar 8000 -ac 1 -f wav "${temp8k}" -y`, {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (ffmpegErr) {
      try {
        execSync(`sox "${tempAiff}" -r 8000 -c 1 "${temp8k}"`, {
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

    const wavData = fs.readFileSync(temp8k);
    if (wavData.length < 44) {
      throw new Error('WAV file too small');
    }
    const pcmData = wavData.slice(44);
    if (pcmData.length === 0) {
      throw new Error('WAV file has no audio data');
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

/** Write high-quality WAV file with optional upsampling and enhancement */
export function writeWavFile(filepath, pcmBuffer, inputSampleRate = 8000) {
  const numChannels = 1;
  const bitsPerSample = OUTPUT_BIT_DEPTH;
  const enableNoiseReduction = process.env.ENABLE_NOISE_REDUCTION !== 'false';

  let processedPcm = pcmBuffer;
  if (inputSampleRate < OUTPUT_SAMPLE_RATE) {
    processedPcm = upsamplePcm(pcmBuffer, inputSampleRate, OUTPUT_SAMPLE_RATE);
  } else if (inputSampleRate > OUTPUT_SAMPLE_RATE) {
    processedPcm = upsamplePcm(pcmBuffer, inputSampleRate, OUTPUT_SAMPLE_RATE);
  }

  if (enableNoiseReduction) {
    processedPcm = enhanceAudio(processedPcm);
  }

  const sampleRate = OUTPUT_SAMPLE_RATE;
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
