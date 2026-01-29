import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import twilio from 'twilio';
import {
  mulawToPcm,
} from './audio.js';
import { createGeminiLiveTranslator } from './geminiLive.js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const LATENCY_LOG = process.env.LATENCY_LOG === '1';
const nowMs = () => Number(process.hrtime.bigint()) / 1e6;

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

const connState = {
  streamSid: null,
};

// let wsConnection = null
let gemini = null
let mode = 'main-menu' // translation | summary | main-menu

wss.on('connection', (ws, req) => {
  // wsConnection = ws;
  // Recording is intentionally disabled (to minimize latency).
  /*const gemini = createGeminiLiveTranslator({
    ws,
    getStreamSid: () => connState.streamSid,
  });*/
  gemini = createGeminiLiveTranslator({
    ws,
    getStreamSid: () => connState.streamSid,
  });
  
  function stopStream() {
    gemini.stop();
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
          // gemini.start();

          console.log('[stream] start', {
            streamSid: msg.streamSid,
            callSid: msg.start?.callSid,
            tracks: msg.start?.tracks,
            mediaFormat: msg.start?.mediaFormat,
          });

          setTimeout(() => {
            gemini.playTts(`Welcome to the translation service by Scam Meets AI. How can I help you today?`);
          }, 20000);
          break;
        case 'media':
          if (msg.media?.payload) {
            const mulaw = Buffer.from(msg.media.payload, 'base64');
            const pcm = mulawToPcm(mulaw);
            if (mode === 'translation') {
              gemini.handleInboundPcm(pcm, msg.media?.track);
            }
          }
          break;
        case 'stop':
          console.log('[stream] stop', msg.streamSid);
          stopStream();
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
    stopStream();
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
          <Transcription statusCallbackUrl="${BASE_URL}/transcribe" transcriptionEngine="deepgram" speechModel="nova-2" profanityFilter="false" /> 
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
      const track = body.Track || '';
      const direction = track === 'inbound_track' ? 'inbound' : track === 'outbound_track' ? 'outbound' : track || 'unknown';
      if (transcript != null && transcript !== '' && direction === 'inbound') {
        console.log('[transcribe]', direction + ':', transcript);

        if (/begin.* translation/i.test(transcript) && mode !== 'translation') {
          console.log('[transcribe] start translation detected:', transcript);
          gemini.start('translate');
          mode = 'translation';
          gemini.playTts(`Okay. Let's Begin Translation`);
        } else if (/end.* translation/i.test(transcript) && mode === 'translation') {
          console.log('[transcribe] end translation detected:', transcript);
          gemini.stop();
          mode = 'main-menu';
          gemini.playTts(`Okay Translation is ended. What else can I help you with?`);
        } else if (/please.* summarize/i.test(transcript) && mode !== 'summary') {
          console.log('[transcribe] start summary detected:', transcript);
          gemini.playTts(`Okay. Summarizing the conversation in progress...`);
        }
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
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`WebSocket (Twilio stream): ${WS_BASE}/stream`);
  if (!twilioClient) {
    console.log('Twilio not configured. Set env vars to enable /call.');
  }
});
