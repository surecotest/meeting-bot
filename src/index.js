import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import twilio from 'twilio';
import path from 'path';
import {
  RECORDINGS_DIR,
  RECORD_INTERVAL_MS,
  OUTPUT_SAMPLE_RATE,
  ensureRecordingsDir,
  mulawToPcm,
  generateTtsAudio,
  writeWavFile,
} from './audio.js';

const app = express();
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
    outboundTimer: null, // Timer for sending audio every 5 seconds
  };

  function flushToFile() {
    if (!connState.streamSid || connState.pcmChunks.length === 0) return;
    ensureRecordingsDir();
    const pcm = Buffer.concat(connState.pcmChunks);
    connState.pcmChunks = [];
    const filename = `stream_${connState.streamSid}_${Date.now()}.wav`;
    const filepath = path.join(RECORDINGS_DIR, filename);
    try {
      writeWavFile(filepath, pcm, 8000); // Input is 8kHz from Twilio
      const duration = (pcm.length / 16000).toFixed(1); // Original duration
      console.log('[stream] wrote', filename, `${duration}s @ ${OUTPUT_SAMPLE_RATE}Hz`);
    } catch (e) {
      console.error('[stream] write error', e);
    }
  }

  function sendOutboundAudio() {
    if (!connState.streamSid || ws.readyState !== ws.OPEN) return;
    
    const mulaw = generateTtsAudio();
    const payload = mulaw.toString('base64');
    
    // Split into chunks (Twilio recommends ~160 bytes per message for 20ms of audio)
    const chunkSize = 160; // ~20ms at 8kHz
    for (let i = 0; i < mulaw.length; i += chunkSize) {
      const chunk = mulaw.slice(i, i + chunkSize);
      const chunkPayload = chunk.toString('base64');
      
      const mediaMsg = {
        event: 'media',
        streamSid: connState.streamSid,
        media: {
          payload: chunkPayload,
        },
      };
      
      try {
        ws.send(JSON.stringify(mediaMsg));
      } catch (e) {
        console.error('[stream] Error sending outbound audio', e);
        return;
      }
    }
    
    // Send mark to track playback completion
    const markMsg = {
      event: 'mark',
      streamSid: connState.streamSid,
      mark: {
        name: `tts_${Date.now()}`,
      },
    };
    try {
      ws.send(JSON.stringify(markMsg));
    } catch (e) {
      console.error('[stream] Error sending mark', e);
    }
  }

  function stopRecording() {
    if (connState.saveTimer) {
      clearInterval(connState.saveTimer);
      connState.saveTimer = null;
    }
    if (connState.outboundTimer) {
      clearInterval(connState.outboundTimer);
      connState.outboundTimer = null;
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
          // Send "Hi Thank you" every 5 seconds
          connState.outboundTimer = setInterval(sendOutboundAudio, 5000);
          // Send immediately on start
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
  // Use <Connect><Stream> for bidirectional streams (can send audio back)
  const connect = response.connect();
  const streamUrl = `${WS_BASE}/stream`;
  connect.stream({
    name: 'MeetingBotStream',
    url: streamUrl,
  });
  // Note: With <Connect><Stream>, subsequent TwiML is not executed
  // The call stays connected while the stream is active
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
