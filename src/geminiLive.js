import { GoogleGenAI, Modality } from '@google/genai';
import { pcmToMulaw, resamplePcm16 } from './audio.js';
import { spawn } from 'child_process';

const clientsByKey = new Map();

function getClient(apiKey) {
  if (!apiKey) return null;
  if (clientsByKey.has(apiKey)) return clientsByKey.get(apiKey);
  const client = new GoogleGenAI({ apiKey });
  clientsByKey.set(apiKey, client);
  return client;
}

/**
 * Create a per-connection Gemini Live translator that:
 * - accepts inbound PCM16 @ 8kHz (Twilio decoded)
 * - streams it to Gemini as PCM16 @ 8kHz (no resampling)
 * - receives Gemini native audio output PCM16 @ 24kHz
 * - resamples once (high-quality) to PCM16 @ 8kHz, converts to μ-law, and sends to Twilio
 */
export function createGeminiLiveTranslator({
  ws,
  getStreamSid,
  apiKey = process.env.GEMINI_API_KEY,
  model = 'gemini-2.5-flash-native-audio-preview-12-2025',
  flushIntervalMs = 200,
} = {}) {
  const geminiClient = getClient(apiKey);
  let warnedMissingKey = false;

  let geminiSession = null;
  let geminiConnectPromise = null;

  let geminiInPcmChunks = [];
  let geminiInFlushTimer = null;

  let outboundMulawQueue = [];
  let outboundPlaybackTimer = null;

  let ffmpegResampler = null;
  let ffmpegUnavailable = false;
  let ffmpegPcmCarry = Buffer.alloc(0);
  let outboundPcm8kRemainder = Buffer.alloc(0);
  let fallbackPcm24kBuffer = Buffer.alloc(0);

  const OUT_SAMPLE_RATE = 8000;
  const FRAME_SAMPLES = 160; // 20ms @ 8kHz
  const FRAME_BYTES_PCM16 = FRAME_SAMPLES * 2; // 320 bytes
  const FALLBACK_MIN_CHUNK_MS = 250;
  const FALLBACK_MIN_CHUNK_BYTES_24K = Math.floor((24000 * FALLBACK_MIN_CHUNK_MS) / 1000) * 2; // 4800 bytes

  function enqueueOutboundPcm8k(pcm8k) {
    if (!pcm8k || pcm8k.length === 0) return;

    // Ensure int16 alignment.
    if (pcm8k.length % 2 !== 0) {
      pcm8k = pcm8k.subarray(0, pcm8k.length - 1);
      if (pcm8k.length === 0) return;
    }

    let buf =
      outboundPcm8kRemainder.length > 0 ? Buffer.concat([outboundPcm8kRemainder, pcm8k]) : pcm8k;

    let offset = 0;
    while (offset + FRAME_BYTES_PCM16 <= buf.length) {
      const framePcm = buf.subarray(offset, offset + FRAME_BYTES_PCM16);
      const frameMulaw = pcmToMulaw(framePcm); // 160 bytes
      outboundMulawQueue.push(frameMulaw);
      offset += FRAME_BYTES_PCM16;
    }

    outboundPcm8kRemainder = buf.subarray(offset);
    if (outboundMulawQueue.length > 0) ensureOutboundPlayback();
  }

  function flushOutboundPcmRemainderWithSilence() {
    if (!outboundPcm8kRemainder || outboundPcm8kRemainder.length === 0) return;
    // Pad ONCE (at stop) to a full 20ms PCM16 frame before encoding.
    const padded = Buffer.concat([
      outboundPcm8kRemainder,
      Buffer.alloc(FRAME_BYTES_PCM16 - outboundPcm8kRemainder.length),
    ]);
    outboundPcm8kRemainder = Buffer.alloc(0);
    enqueueOutboundPcm8k(padded);
  }

  function startFfmpegResampler() {
    if (ffmpegResampler || ffmpegUnavailable) return;

    try {
      ffmpegResampler = spawn(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          // Input: PCM16LE mono @ 24kHz
          '-f',
          's16le',
          '-ar',
          '24000',
          '-ac',
          '1',
          '-i',
          'pipe:0',
          // Output: PCM16LE mono @ 8kHz
          '-f',
          's16le',
          '-ar',
          '8000',
          '-ac',
          '1',
          'pipe:1',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );
    } catch (e) {
      ffmpegUnavailable = true;
      ffmpegResampler = null;
      return;
    }

    ffmpegResampler.on('error', (err) => {
      // e.g. ENOENT if ffmpeg isn't installed
      console.warn('[gemini] ffmpeg resampler unavailable, falling back to linear resample:', err?.message ?? err);
      ffmpegUnavailable = true;
      stopFfmpegResampler();
    });

    ffmpegResampler.on('close', (code, signal) => {
      if (ffmpegUnavailable) return;
      if (code === 0) return;
      console.warn('[gemini] ffmpeg resampler exited, falling back to linear resample:', { code, signal });
      ffmpegUnavailable = true;
      stopFfmpegResampler();
    });

    ffmpegResampler.stdout.on('data', (chunk) => {
      // Ensure 16-bit alignment before framing/encoding.
      let buf = ffmpegPcmCarry.length ? Buffer.concat([ffmpegPcmCarry, chunk]) : chunk;
      if (buf.length % 2 !== 0) {
        ffmpegPcmCarry = buf.subarray(buf.length - 1);
        buf = buf.subarray(0, buf.length - 1);
      } else {
        ffmpegPcmCarry = Buffer.alloc(0);
      }

      if (buf.length === 0) return;
      enqueueOutboundPcm8k(buf);
    });
  }

  function stopFfmpegResampler() {
    ffmpegPcmCarry = Buffer.alloc(0);
    if (!ffmpegResampler) return;
    try {
      ffmpegResampler.stdin?.end?.();
    } catch (_) {}
    try {
      ffmpegResampler.kill('SIGKILL');
    } catch (_) {}
    ffmpegResampler = null;
  }

  function resetOutboundAudioPipeline() {
    outboundMulawQueue = [];
    outboundPcm8kRemainder = Buffer.alloc(0);
    fallbackPcm24kBuffer = Buffer.alloc(0);
    stopOutboundPlayback();
    stopFfmpegResampler();
    // Allow retrying ffmpeg if it exited unexpectedly but is installed.
    // If it's genuinely unavailable (ENOENT), we'll keep the fallback.
    ffmpegPcmCarry = Buffer.alloc(0);
  }

  function logMissingKeyOnce() {
    if (warnedMissingKey) return;
    warnedMissingKey = true;
    console.warn('[gemini] GEMINI_API_KEY not set; translation disabled');
  }

  function sendMark(streamSid) {
    const markMsg = {
      event: 'mark',
      streamSid,
      mark: {
        name: `xlate_${Date.now()}`,
      },
    };
    try {
      ws.send(JSON.stringify(markMsg));
    } catch (e) {
      console.error('[stream] Error sending mark', e);
    }
  }

  function sendOneOutboundFrame() {
    const streamSid = getStreamSid?.();
    // ws.OPEN is not guaranteed to exist on instances; 1 is the OPEN readyState.
    if (!streamSid || ws?.readyState !== 1) {
      stopOutboundPlayback();
      return;
    }
    if (outboundMulawQueue.length === 0) {
      stopOutboundPlayback();
      return;
    }

    // EXACTLY one 20ms frame (μ-law 8kHz: 160 bytes)
    const frame = outboundMulawQueue.shift();
    if (!frame) {
      stopOutboundPlayback();
      return;
    }
    if (frame.length !== 160) {
      console.warn('[audio] bad μ-law frame size:', frame.length);
      return;
    }

    ws.send(
      JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload: frame.toString('base64') },
      })
    );

    // If we just drained the queue, send a single mark and stop playback.
    if (outboundMulawQueue.length === 0) {
      sendMark(streamSid);
      stopOutboundPlayback();
    }
  }

  function ensureOutboundPlayback() {
    if (outboundPlaybackTimer) return;
    // Pace at ~real-time (20ms per 160-byte μ-law frame)
    outboundPlaybackTimer = setInterval(sendOneOutboundFrame, 20);
  }

  function stopOutboundPlayback() {
    if (!outboundPlaybackTimer) return;
    clearInterval(outboundPlaybackTimer);
    outboundPlaybackTimer = null;
  }

  async function ensureGeminiSession() {
    if (!geminiClient) return null;
    if (geminiSession) return geminiSession;
    if (geminiConnectPromise) return geminiConnectPromise;

    const config = {
      responseModalities: [Modality.AUDIO],
      outputAudioTranscription: {},
      thinkingConfig: { thinkingBudget: 0 },
      systemInstruction:
        'You are a real-time interpreter. Listen to the caller speaking Thai (th-TH) and respond with spoken English only. ' +
        'Do not repeat the Thai. Do not add commentary. Keep the translation concise and natural.',
    };

    geminiConnectPromise = geminiClient.live
      .connect({
        model,
        config,
        callbacks: {
          onopen: () => {
            console.log('[gemini] live session opened');
          },
          onmessage: (message) => {
            try {
              if (message?.serverContent?.interrupted) {
                resetOutboundAudioPipeline();
                return;
              }

              // Native audio output arrives as base64 PCM16 @ 24kHz in message.data
              if (message?.data) {
                const pcm24k = Buffer.from(message.data, 'base64');
                if (pcm24k.length > 0) {
                  if (!ffmpegUnavailable) {
                    startFfmpegResampler();
                  }

                  if (ffmpegResampler?.stdin?.writable && !ffmpegUnavailable) {
                    ffmpegResampler.stdin.write(pcm24k);
                  } else {
                    // Fallback (lower quality): linear resample in JS
                    // Buffer and resample in larger chunks to reduce zipper noise.
                    fallbackPcm24kBuffer = Buffer.concat([fallbackPcm24kBuffer, pcm24k]);
                    // Keep alignment.
                    if (fallbackPcm24kBuffer.length % 2 !== 0) {
                      fallbackPcm24kBuffer = fallbackPcm24kBuffer.subarray(0, fallbackPcm24kBuffer.length - 1);
                    }
                    while (fallbackPcm24kBuffer.length >= FALLBACK_MIN_CHUNK_BYTES_24K) {
                      const chunk24k = fallbackPcm24kBuffer.subarray(0, FALLBACK_MIN_CHUNK_BYTES_24K);
                      fallbackPcm24kBuffer = fallbackPcm24kBuffer.subarray(FALLBACK_MIN_CHUNK_BYTES_24K);
                      const pcm8k = resamplePcm16(chunk24k, 24000, OUT_SAMPLE_RATE);
                      enqueueOutboundPcm8k(pcm8k);
                    }
                  }
                }
              }

              // Optional: log the model's spoken output transcript (English)
              if (message?.serverContent?.outputTranscription?.text) {
                console.log('[gemini] EN:', message.serverContent.outputTranscription.text);
              }
            } catch (e) {
              console.error('[gemini] onmessage handler error', e);
            }
          },
          onerror: (e) => {
            console.error('[gemini] live error', e?.message ?? e);
          },
          onclose: (e) => {
            console.log('[gemini] live closed', e?.reason ?? '');
            geminiSession = null;
          },
        },
      })
      .then((session) => {
        geminiSession = session;
        return session;
      })
      .catch((err) => {
        console.error('[gemini] failed to connect', err?.message ?? err);
        return null;
      })
      .finally(() => {
        geminiConnectPromise = null;
      });

    return geminiConnectPromise;
  }

  function flushGeminiAudio() {
    if (!geminiSession) return;
    if (geminiInPcmChunks.length === 0) return;

    const pcm8k = Buffer.concat(geminiInPcmChunks);
    geminiInPcmChunks = [];
    if (pcm8k.length === 0) return;

    try {
      geminiSession.sendRealtimeInput({
        audio: {
          data: pcm8k.toString('base64'),
          mimeType: 'audio/pcm;rate=8000',
        },
      });
    } catch (e) {
      console.error('[gemini] sendRealtimeInput error', e?.message ?? e);
    }
  }

  function start() {
    if (!geminiClient) {
      logMissingKeyOnce();
      return;
    }

    ensureGeminiSession().catch(() => {});
    if (!geminiInFlushTimer) {
      geminiInFlushTimer = setInterval(flushGeminiAudio, flushIntervalMs);
    }
  }

  function handleInboundPcm(pcm8k, track) {
    // Avoid retranslating our own outbound audio (Twilio provides track=inbound/outbound in bidirectional mode)
    const isInbound = !track || track === 'inbound';
    if (!isInbound) return;

    if (geminiSession) {
      geminiInPcmChunks.push(pcm8k);
      return;
    }

    if (!geminiClient) {
      logMissingKeyOnce();
      return;
    }

    ensureGeminiSession().then((session) => {
      if (session) geminiInPcmChunks.push(pcm8k);
    });
  }

  function stop() {
    if (geminiInFlushTimer) {
      clearInterval(geminiInFlushTimer);
      geminiInFlushTimer = null;
    }
    stopOutboundPlayback();
    flushOutboundPcmRemainderWithSilence();
    stopFfmpegResampler();

    geminiInPcmChunks = [];
    outboundMulawQueue = [];

    if (geminiSession) {
      try {
        geminiSession.sendRealtimeInput({ audioStreamEnd: true });
      } catch (_) {}
      try {
        geminiSession.close();
      } catch (_) {}
      geminiSession = null;
    }
  }

  return { start, handleInboundPcm, stop };
}

