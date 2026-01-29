import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import twilio from 'twilio';
import { GoogleGenAI } from '@google/genai';
import {
  mulawToPcm,
  ensureRecordingsDir,
  writeMulawWavFile,
  writeWavFile,
  RECORDINGS_DIR,
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

const recordCodec = (process.env.RECORD_CODEC || '').toLowerCase();
const recordingEnabled = ['pcm', 'mulaw', 'both'].includes(recordCodec);

// --- WebSocket server for Twilio Media Streams ---

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/stream' });

const connState = {
  streamSid: null,
};

// let wsConnection = null
let gemini = null;
let mode = 'main-menu'; // translation | summary | main-menu
/** Set when stream starts, cleared when stream stops. Used to save recording when ending translation. */
let activeFlushRecording = null;

wss.on('connection', (ws, req) => {
  gemini = createGeminiLiveTranslator({
    ws,
    getStreamSid: () => connState.streamSid,
  });

  const recordMulawBuffers = [];
  const recordPcmBuffers = [];

  function flushRecording() {
    ensureRecordingsDir();
    const timestamp = Date.now();
    const basePath = `${RECORDINGS_DIR}/${timestamp}`;
    if ((recordCodec === 'mulaw' || recordCodec === 'both') && recordMulawBuffers.length > 0) {
      const mulawBuffer = Buffer.concat(recordMulawBuffers);
      const p = recordCodec === 'both' ? `${basePath}_mulaw.wav` : `${basePath}.wav`;
      writeMulawWavFile(p, mulawBuffer, 8000);
    }
    if ((recordCodec === 'pcm' || recordCodec === 'both') && recordPcmBuffers.length > 0) {
      const pcmBuffer = Buffer.concat(recordPcmBuffers);
      const p = recordCodec === 'both' ? `${basePath}_pcm.wav` : `${basePath}.wav`;
      writeWavFile(p, pcmBuffer, 8000);
    }
    recordMulawBuffers.length = 0;
    recordPcmBuffers.length = 0;
  }

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
          activeFlushRecording = flushRecording;

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
            if (recordingEnabled) recordMulawBuffers.push(Buffer.from(mulaw));
            if (recordingEnabled && (recordCodec === 'pcm' || recordCodec === 'both')) {
              recordPcmBuffers.push(mulawToPcm(mulaw));
            }
            const pcm = mulawToPcm(mulaw);
            if (mode === 'translation') {
              gemini.handleInboundPcm(pcm, msg.media?.track);
            }
          }
          break;
        case 'stop':
          console.log('[stream] stop', msg.streamSid);
          activeFlushRecording = null;
          if (recordingEnabled) flushRecording();
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

// --- Recordings list and summarize ---

function listRecordings() {
  try {
    if (!fs.existsSync(RECORDINGS_DIR)) return [];
    const files = fs.readdirSync(RECORDINGS_DIR).filter((f) => f.endsWith('.wav'));
    files.sort((a, b) => {
      const tsA = a.replace(/_?(mulaw|pcm)?\.wav$/i, '');
      const tsB = b.replace(/_?(mulaw|pcm)?\.wav$/i, '');
      return Number(tsB) - Number(tsA);
    });
    return files.map((f) => {
      const ts = f.replace(/_?(mulaw|pcm)?\.wav$/i, '');
      const n = Number(ts);
      return { file: f, timestamp: Number.isNaN(n) ? null : n };
    });
  } catch {
    return [];
  }
}

function getLatestRecordingPath() {
  const list = listRecordings();
  return list.length > 0 ? path.join(RECORDINGS_DIR, list[0].file) : null;
}

/** Summarize the latest recording via Gemini. Returns { file, summary }. Throws on error. */
async function summarizeLatestRecording() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not set.');
  }
  const filePath = getLatestRecordingPath();
  if (!filePath) {
    throw new Error('No recordings found in recordings/.');
  }
  const base64Audio = fs.readFileSync(filePath, { encoding: 'base64' });
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      { text: 'Summarize this audio recording. Provide a concise summary of what was discussed.' },
      { inlineData: { mimeType: 'audio/wav', data: base64Audio } },
    ],
  });
  const summary = response?.text?.trim() ?? '';
  const file = path.basename(filePath);
  return { file, summary };
}

/** Call summarize-latest; returns { file, summary } or throws (convenience wrapper). */
async function summarizeLatest() {
  return summarizeLatestRecording();
}

/** Safe filename: only basename, no path traversal */
function safeRecordingFilename(name) {
  const base = path.basename(name);
  return base.endsWith('.wav') && !base.includes('..') ? base : null;
}

app.get('/api/recordings', (req, res) => {
  res.json({ recordings: listRecordings() });
});

app.get('/api/recordings/audio/:filename', (req, res) => {
  const filename = safeRecordingFilename(req.params.filename || '');
  if (!filename) {
    return res.status(400).json({ error: 'Invalid filename.' });
  }
  const filePath = path.join(RECORDINGS_DIR, filename);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return res.status(404).json({ error: 'Recording not found.' });
  }
  res.type('audio/wav');
  res.sendFile(path.resolve(filePath));
});

app.get('/api/summarize', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not set.' });
  }

  const filename = safeRecordingFilename(req.query.file || '');
  if (!filename) {
    return res.status(400).json({ error: 'Missing or invalid "file" (e.g. 1769666978398.wav).' });
  }

  const filePath = path.join(RECORDINGS_DIR, filename);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return res.status(404).json({ error: 'Recording not found.' });
  }

  const lang = (req.query.lang || 'en').toLowerCase();
  const langInstructions = {
    en: 'Write the summary in English.',
    th: 'Write the summary in Thai (ไทย).',
    es: 'Write the summary in Spanish (Español).',
    fr: 'Write the summary in French (Français).',
    de: 'Write the summary in German (Deutsch).',
    ja: 'Write the summary in Japanese (日本語).',
    zh: 'Write the summary in Chinese (中文).',
    ko: 'Write the summary in Korean (한국어).',
    hi: 'Write the summary in Hindi (हिन्दी).',
    ar: 'Write the summary in Arabic (العربية).',
    pt: 'Write the summary in Portuguese (Português).',
    it: 'Write the summary in Italian (Italiano).',
    vi: 'Write the summary in Vietnamese (Tiếng Việt).',
    id: 'Write the summary in Indonesian (Bahasa Indonesia).',
  };
  const langInstruction = langInstructions[lang] || langInstructions.en;

  try {
    const base64Audio = fs.readFileSync(filePath, { encoding: 'base64' });
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          text: `Summarize this audio recording. Provide a concise summary of what was discussed. ${langInstruction}`,
        },
        { inlineData: { mimeType: 'audio/wav', data: base64Audio } },
      ],
    });

    const summary = response?.text?.trim() ?? '';
    res.json({ file: filename, summary });
  } catch (err) {
    console.error('[api/summarize] error', err?.message ?? err);
    res.status(500).json({ error: err.message || 'Failed to summarize audio.' });
  }
});

app.get('/summarize-latest', async (req, res) => {
  try {
    const data = await summarizeLatestRecording();
    res.json(data);
  } catch (err) {
    console.error('[summarize-latest] error', err?.message ?? err);
    if (err.message === 'No recordings found in recordings/.') {
      res.status(404).json({ error: err.message });
    } else {
      res.status(500).json({ error: err.message || 'Failed to summarize audio.' });
    }
  }
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
          gemini.playTts(`Okay. Translation ended. What else can I help you with?`);
        } else if (/please.* summarize/i.test(transcript) && mode !== 'summary') {
          console.log('[transcribe] please summarize detected:', transcript);
          mode = 'summary';
          gemini.playTts(`Okay. Summarizing...`);
          if (recordingEnabled && activeFlushRecording) {
            activeFlushRecording();
          }
          summarizeLatest()
            .then((data) => {
              if (data?.summary && gemini) {
                gemini.playTts(data.summary);
              }
            })
            .catch((err) => console.error('[transcribe] summarize-latest error', err?.message ?? err));
        }
      }
    } catch (e) {
      console.error('[transcribe] parse TranscriptionData error', e.message);
    }
  }

  res.type('application/json');
  res.status(200).json({ received: true });
});

// --- Recordings page (list + summarize) ---

app.get('/recordings', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'recordings.html'));
});

// --- Health ---

app.get('/', (req, res) => {
  res.json({
    service: 'meeting-bot',
    endpoints: {
      'GET /recordings': 'Recordings page (list + summarize)',
      'GET /api/recordings': 'List recordings',
      'GET /api/recordings/audio/:filename': 'Stream a recording (WAV) for playback',
      'GET /api/summarize?file=<name>': 'Summarize a recording',
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

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`WebSocket (Twilio stream): ${WS_BASE}/stream`);
  if (!twilioClient) {
    console.log('Twilio not configured. Set env vars to enable /call.');
  }
  // Check ffmpeg once at startup so user knows to install or set FFMPEG_PATH
  let ffmpegWarned = false;
  const ffmpegCheck = spawn(FFMPEG_PATH, ['-version'], { stdio: 'ignore' });
  ffmpegCheck.on('error', (err) => {
    if (ffmpegWarned) return;
    ffmpegWarned = true;
    if (err?.code === 'ENOENT') {
      console.error(
        '[ffmpeg] not found in PATH. Outbound audio will be dropped. Install ffmpeg or set FFMPEG_PATH.'
      );
    } else {
      console.error('[ffmpeg] check failed:', err?.message ?? err);
    }
  });
  ffmpegCheck.on('close', (code) => {
    if (ffmpegWarned || code === 0 || code == null) return;
    ffmpegWarned = true;
    console.error('[ffmpeg] exited with code', code, '— outbound audio will be dropped.');
  });
});
