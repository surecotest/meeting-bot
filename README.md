# meeting-bot

Express app that places outbound calls via the Twilio API and receives real-time call audio over WebSockets (Twilio Media Streams).

## Features

- **Twilio outbound calls** – `POST /call` starts a call to a phone number.
- **WebSocket stream** – Twilio streams call audio to `ws://.../stream` using [Media Streams](https://www.twilio.com/docs/voice/media-streams).
- **TwiML webhook** – `/voice` returns TwiML that starts a unidirectional stream to your WebSocket server.

## Quick start

```bash
cp .env.example .env
# Edit .env: add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER

npm install
npm run dev
```

## Local development with Twilio

Twilio must reach your server over the internet. Use a tunnel (e.g. [ngrok](https://ngrok.com)):

```bash
ngrok http 3000
```

Set in `.env`:

```env
BASE_URL=https://YOUR_SUBDOMAIN.ngrok.io
```

Twilio will use `BASE_URL` for the TwiML webhook and `wss://YOUR_SUBDOMAIN.ngrok.io/stream` for the Media Stream.

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Service info and endpoint list |
| `/call` | POST | Start outbound call. Body: `{ "to": "+15551234567" }` |
| `/voice` | GET/POST | TwiML webhook – starts stream to `/stream` |
| `/stream` | WebSocket | Twilio Media Streams endpoint |

## WebSocket messages (from Twilio)

Your server receives JSON messages with `event`:

- `connected` – connection established
- `start` – stream metadata (streamSid, callSid, tracks, mediaFormat)
- `media` – audio chunk; `payload` is base64 μ-law 8kHz
- `stop` – stream ended
- `dtmf` – keypress (bidirectional streams)
- `mark` – playback marker (bidirectional)

See [WebSocket Messages](https://www.twilio.com/docs/voice/media-streams/websocket-messages) for full schema.

## Example: place a call

```bash
curl -X POST http://localhost:3000/call \
  -H "Content-Type: application/json" \
  -d '{"to": "+15551234567"}'
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `PORT` | HTTP port (default: 3000) |
| `BASE_URL` | Public URL for Twilio (e.g. `https://xxx.ngrok.io`) |
| `TWILIO_ACCOUNT_SID` | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token |
| `TWILIO_PHONE_NUMBER` | Twilio number used as “from” |
| `LOG_MEDIA_CHUNKS` | Set to `1` to log every media chunk (verbose) |
| `RECORD_CODEC` | Recording format: `pcm` (default), `mulaw`, or `both` |
