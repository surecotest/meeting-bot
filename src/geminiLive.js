import { GoogleGenAI, Modality } from '@google/genai';
import { pcmToMulaw, resamplePcm16 } from './audio.js';

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
 * - streams it to Gemini as PCM16 @ 16kHz
 * - receives Gemini native audio output PCM16 @ 24kHz
 * - converts to Twilio μ-law 8kHz and sends to the Twilio websocket
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
    if (!geminiSession) {
      stopOutboundPlayback();
      return;
    }
    if (outboundMulawQueue.length === 0) {
      stopOutboundPlayback();
      return;
    }

    // Twilio expects ~20ms frames => 160 bytes per message (μ-law 8kHz, 1 byte/sample)
    const frameSize = 160;
    const parts = [];
    let remaining = frameSize;
    while (remaining > 0 && outboundMulawQueue.length > 0) {
      const head = outboundMulawQueue[0];
      const take = Math.min(head.length, remaining);
      parts.push(head.subarray(0, take));
      if (take === head.length) {
        outboundMulawQueue.shift();
      } else {
        outboundMulawQueue[0] = head.subarray(take);
      }
      remaining -= take;
    }

    if (parts.length === 0) {
      stopOutboundPlayback();
      return;
    }

    let frame = Buffer.concat(parts);
    if (frame.length < frameSize) {
      // Pad final frame with μ-law silence (0x7f)
      frame = Buffer.concat([frame, Buffer.alloc(frameSize - frame.length, 0x7f)]);
    }

    const mediaMsg = {
      event: 'media',
      streamSid,
      media: {
        payload: frame.toString('base64'),
      },
    };

    try {
      ws.send(JSON.stringify(mediaMsg));
    } catch (e) {
      console.error('[stream] Error sending outbound audio', e);
      stopOutboundPlayback();
      return;
    }

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
                outboundMulawQueue = [];
                return;
              }

              // Native audio output arrives as base64 PCM16 @ 24kHz in message.data
              if (message?.data) {
                const pcm24k = Buffer.from(message.data, 'base64');
                if (pcm24k.length > 0) {
                  const pcm8k = resamplePcm16(pcm24k, 24000, 8000);
                  const mulaw8k = pcmToMulaw(pcm8k);
                  outboundMulawQueue.push(mulaw8k);
                  ensureOutboundPlayback();
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
    const pcm16k = resamplePcm16(pcm8k, 8000, 16000);
    if (pcm16k.length === 0) return;

    try {
      geminiSession.sendRealtimeInput({
        audio: {
          data: pcm16k.toString('base64'),
          mimeType: 'audio/pcm;rate=16000',
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

