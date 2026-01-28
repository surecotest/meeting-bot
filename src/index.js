import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import twilio from 'twilio';
import path from 'path';
import {
  RECORDINGS_DIR,
  RECORD_INTERVAL_MS,
  ensureRecordingsDir,
  mulawToPcm,
  writeMulawWavFile,
  writeWavFile,
} from './audio.js';
import { createGeminiLiveTranslator } from './geminiLive.js';

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
    mulawChunks: [],
    saveTimer: null,
  };

  const gemini = createGeminiLiveTranslator({
    ws,
    getStreamSid: () => connState.streamSid,
  });

  function flushToFile() {
    if (!connState.streamSid) return;
    if (connState.pcmChunks.length === 0 && connState.mulawChunks.length === 0) return;
    ensureRecordingsDir();
    const pcm = connState.pcmChunks.length ? Buffer.concat(connState.pcmChunks) : Buffer.alloc(0);
    const mulaw = connState.mulawChunks.length ? Buffer.concat(connState.mulawChunks) : Buffer.alloc(0);
    connState.pcmChunks = [];
    connState.mulawChunks = [];

    const sampleRate = 8000; // Twilio inbound is 8kHz μ-law
    const recordCodec = (process.env.RECORD_CODEC || 'pcm').toLowerCase(); // pcm | mulaw | both
    const base = `stream_${connState.streamSid}_${Date.now()}`;
    try {
      if (recordCodec === 'mulaw' || recordCodec === 'both') {
        const filename = `${base}_mulaw.wav`;
        const filepath = path.join(RECORDINGS_DIR, filename);
        writeMulawWavFile(filepath, mulaw, sampleRate);
        const duration = (mulaw.length / sampleRate).toFixed(1);
        console.log('[stream] wrote', filename, `${duration}s @ ${sampleRate}Hz (μ-law)`);
      }

      if (recordCodec === 'pcm' || recordCodec === 'both') {
        const filename = recordCodec === 'both' ? `${base}_pcm.wav` : `${base}.wav`;
        const filepath = path.join(RECORDINGS_DIR, filename);
        writeWavFile(filepath, pcm, sampleRate);
        const duration = (pcm.length / 16000).toFixed(1); // bytes/sec for PCM16 @ 8kHz
        console.log('[stream] wrote', filename, `${duration}s @ ${sampleRate}Hz (PCM16)`);
      }
    } catch (e) {
      console.error('[stream] write error', e);
    }
  }

  function stopRecording() {
    if (connState.saveTimer) {
      clearInterval(connState.saveTimer);
      connState.saveTimer = null;
    }
    gemini.stop();
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
          gemini.start();

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
            connState.mulawChunks.push(mulaw);
            gemini.handleInboundPcm(pcm, msg.media?.track);
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

// --- Initiate outbound call that joins Zoom via SIP ---

app.post('/call/zoom', async (req, res) => {
  if (!twilioClient) {
    return res.status(500).json({
      error: 'Twilio not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER.',
    });
  }

  const streamUrl = `${WS_BASE}/stream`;

  const to = req.body?.to || req.query?.to;
  const from = req.body?.from || req.query?.from || twilioPhoneNumber;
  const meetingId = req.body?.meetingId ?? req.query?.meetingId;
  const passcode = req.body?.passcode ?? req.query?.passcode;

  if (!to) {
    return res.status(400).json({ error: 'Missing "to" (phone number).' });
  }
  if (!from) {
    return res.status(400).json({ error: 'Missing "from" (Twilio number). Set TWILIO_PHONE_NUMBER or pass "from".' });
  }
  if (meetingId === undefined || meetingId === null || meetingId === '') {
    return res.status(400).json({ error: 'Missing "meetingId".' });
  }

  const meetingIdStr = String(meetingId).trim();
  const passcodeStr = passcode != null && passcode !== '' ? String(passcode).trim() : '';

  const params = new URLSearchParams({ meetingId: meetingIdStr });
  if (passcodeStr) params.set('passcode', passcodeStr);

  if (BASE_URL.startsWith('http://localhost')) {
    console.warn('[call/zoom] BASE_URL is localhost. Twilio cannot reach it. Use ngrok and set BASE_URL.');
  }

  try {
    const twiml = `
      <Response>
        <Start>
          <Transcription statusCallbackUrl="${BASE_URL}/transcribe"/> 
        </Start>   
        <Pause length="1" />
        <Play digits="${meetingIdStr}#"></Play>
        <Pause length="3"/>
        <Play digits="#"></Play>
        <Pause length="3"/>
        <Play digits="${passcodeStr}#"></Play>
        <Connect>
          <Stream url="${streamUrl}" />
        </Connect>
      </Response>`;
    const call = await twilioClient.calls.create({
      to,
      from,
      twiml
    });
    res.json({ sid: call.sid, status: call.status });
  } catch (err) {
    console.error('[call/zoom] Twilio error', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Transcribe: print TranscriptionData.transcript (Twilio Real-Time Transcription callback) ---

app.all('/transcribe', (req, res) => {
  const body = req.body || {};
  const event = body.TranscriptionEvent;
  const transcriptionDataRaw = body.TranscriptionData;

  if (event === 'transcription-content' && transcriptionDataRaw) {
    try {
      const data = typeof transcriptionDataRaw === 'string' ? JSON.parse(transcriptionDataRaw) : transcriptionDataRaw;
      const transcript = data?.transcript;
      if (transcript != null && transcript !== '') {
        console.log('Transcribe: ' + transcript);
      }
    } catch (e) {
      console.error('[transcribe] parse TranscriptionData error', e.message);
    }
  }

  res.type('application/json');
  res.status(200).json({ received: true });
});

// --- Health ---

app.get('/', (req, res) => {
  res.json({
    service: 'meeting-bot',
    endpoints: {
      'POST /call': 'Start outbound call (body: { from?, to })',
      'POST /call/zoom': 'Start outbound call that joins Zoom via SIP (body: { from?, to, meetingId, passcode? })',
      'GET/POST /transcribe': 'Echo and print request payload (query + body)',
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
