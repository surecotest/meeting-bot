import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import twilio from 'twilio';
import fs from 'fs';
import path from 'path';

const app = express();

// --- Recording: μ-law → PCM, WAV every 1 min ---

const RECORDINGS_DIR = path.join(process.cwd(), 'recordings');
const RECORD_INTERVAL_MS = 60 * 1000; // 1 minute

function ensureRecordingsDir() {
  try {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  } catch (_) {}
}

/** G.711 μ-law expand to 16-bit PCM (little-endian) */
function mulawToPcm(mulawBuf) {
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

/** Write 8 kHz mono 16-bit WAV file */
function writeWavFile(filepath, pcmBuffer, sampleRate = 8000) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  fs.writeFileSync(filepath, Buffer.concat([header, pcmBuffer]));
}
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT ?? 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const WS_BASE = BASE_URL.replace(/^http/, 'ws');

// Twilio client (optional for making outbound calls)
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
const twilioClient =
  accountSid && authToken
    ? twilio(accountSid, authToken)
    : null;

// --- WebSocket server for Twilio Media Streams ---

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (ws, req) => {
  const connState = {
    streamSid: null,
    pcmChunks: [],
    saveTimer: null,
  };

  function flushToFile() {
    if (!connState.streamSid || connState.pcmChunks.length === 0) return;
    ensureRecordingsDir();
    const pcm = Buffer.concat(connState.pcmChunks);
    connState.pcmChunks = [];
    const filename = `stream_${connState.streamSid}_${Date.now()}.wav`;
    const filepath = path.join(RECORDINGS_DIR, filename);
    try {
      writeWavFile(filepath, pcm, 8000);
      console.log('[stream] wrote', filename, `${(pcm.length / 16000).toFixed(1)}s`);
    } catch (e) {
      console.error('[stream] write error', e);
    }
  }

  function stopRecording() {
    if (connState.saveTimer) {
      clearInterval(connState.saveTimer);
      connState.saveTimer = null;
    }
    flushToFile();
  }

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.event) {
        case 'connected':
          console.log('[stream] Twilio connected', msg.protocol, msg.version);
          break;
        case 'start':
          connState.streamSid = msg.streamSid;
          connState.saveTimer = setInterval(flushToFile, RECORD_INTERVAL_MS);
          console.log('[stream] start', {
            streamSid: msg.streamSid,
            callSid: msg.start?.callSid,
            tracks: msg.start?.tracks,
            mediaFormat: msg.start?.mediaFormat,
          });
          break;
        case 'media':
          if (msg.media?.payload) {
            const mulaw = Buffer.from(msg.media.payload, 'base64');
            const pcm = mulawToPcm(mulaw);
            connState.pcmChunks.push(pcm);
          }
          break;
        case 'stop':
          console.log('[stream] stop', msg.streamSid);
          stopRecording();
          connState.streamSid = null;
          break;
        case 'dtmf':
          console.log('[stream] dtmf', msg.dtmf?.digit);
          break;
        case 'mark':
          console.log('[stream] mark', msg.mark?.name);
          break;
        default:
          console.log('[stream] unknown event', msg.event);
      }
    } catch (e) {
      console.error('[stream] message parse error', e);
    }
  });

  ws.on('close', () => {
    stopRecording();
  });

  ws.on('error', (err) => {
    console.error('[stream] ws error', err);
  });
});

// --- Voice webhook: returns TwiML that streams the call to our WebSocket ---

const VoiceResponse = twilio.twiml.VoiceResponse;

app.all('/voice', (req, res) => {
  const response = new VoiceResponse();
  // const start = response.start();
  const connect = response.connect();
  const streamUrl = `${WS_BASE}/stream`;
  connect.stream({
    name: 'MeetingBotStream',
    url: streamUrl,
    // track: 'both_tracks',
  });
  response.say('Stream started. You are connected to the meeting bot.');
  // Keep the call open so the Media Stream continues; max Pause is 4 hours
  res.type('text/xml');
  res.send(response.toString());
});

// --- Initiate outbound call ---

app.post('/call', async (req, res) => {
  if (!twilioClient) {
    return res.status(500).json({
      error: 'Twilio not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER.',
    });
  }

  const to = req.body?.to || req.query?.to;
  const from = req.body?.from || req.query?.from || twilioPhoneNumber;

  if (!to) {
    return res.status(400).json({ error: 'Missing "to" (phone number).' });
  }
  if (!from) {
    return res.status(400).json({ error: 'Missing "from" (Twilio number). Set TWILIO_PHONE_NUMBER or pass "from".' });
  }

  const voiceUrl = `${BASE_URL}/voice`;
  if (BASE_URL.startsWith('http://localhost')) {
    console.warn(
      '[call] BASE_URL is localhost. Twilio cannot reach it. Use ngrok or similar and set BASE_URL to your public wss URL (e.g. https://xxx.ngrok.io).'
    );
  }

  try {
    const call = await twilioClient.calls.create({
      to,
      from,
      url: voiceUrl,
    });
    res.json({ sid: call.sid, status: call.status });
  } catch (err) {
    console.error('[call] Twilio error', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Health ---

app.get('/', (req, res) => {
  res.json({
    service: 'meeting-bot',
    endpoints: {
      'POST /call': 'Start outbound call (body: { to })',
      'GET /voice': 'TwiML webhook – stream call audio to /stream',
      'ws /stream': 'WebSocket for Twilio Media Streams',
    },
    baseUrl: BASE_URL,
    wsUrl: `${WS_BASE}/stream`,
  });
});

server.listen(PORT, () => {
  ensureRecordingsDir();
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`WebSocket (Twilio stream): ${WS_BASE}/stream`);
  console.log(`Recordings (every ${RECORD_INTERVAL_MS / 1000}s): ${RECORDINGS_DIR}`);
  if (!twilioClient) {
    console.log('Twilio not configured. Set env vars to enable /call.');
  }
});
