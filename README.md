# CallMe

**Minimal plugin that lets Claude Code call you on the phone.**

Start a task, walk away. Your phone/watch rings when Claude is done, stuck, or needs a decision.

<img src="./call-me-comic-min.png" width="800" alt="CallMe comic strip">

- **Minimal plugin** - Does one thing: call you on the phone. No crazy setups.
- **Multi-turn conversations** - Talk through decisions naturally.
- **Works anywhere** - Smartphone, smartwatch, or even landline!
- **Tool-use composable** - Claude can e.g. do a web search while on a call with you.

---

## Quick Start

### 1. Get Required Accounts

You'll need:
- **Phone provider**: [Telnyx](https://telnyx.com) or [Twilio](https://twilio.com)
- **OpenAI API key**: For speech-to-text (and text-to-speech if not using Kokoro)
- **ngrok account**: Free at [ngrok.com](https://ngrok.com) (for webhook tunneling)

### 2. Set Up Phone Provider

Choose **one** of the following:

<details>
<summary><b>Option A: Telnyx (Recommended - 50% cheaper)</b></summary>

1. Create account at [portal.telnyx.com](https://portal.telnyx.com) and verify your identity
2. [Buy a phone number](https://portal.telnyx.com/#/numbers/buy-numbers) (~$1/month)
3. [Create a Voice API application](https://portal.telnyx.com/#/call-control/applications):
   - Set webhook URL to `https://your-ngrok-url/twiml` and API version to v2
     - You can see your ngrok URL on the ngrok dashboard
   - Note your **Application ID** and **API Key**
4. [Verify the phone number](https://portal.telnyx.com/#/numbers/verified-numbers) you want to receive calls at
5. (Optional but recommended) Get your **Public Key** from Account Settings > Keys & Credentials for webhook signature verification

**Environment variables for Telnyx:**
```bash
CALLME_PHONE_PROVIDER=telnyx
CALLME_PHONE_ACCOUNT_SID=<Application ID>
CALLME_PHONE_AUTH_TOKEN=<API Key>
CALLME_TELNYX_PUBLIC_KEY=<Public Key>  # Optional: enables webhook security
```

</details>

<details>
<summary><b>Option B: Twilio (Not recommended - need to buy $20 of credits just to start and more expensive overall)</b></summary>

1. Create account at [twilio.com/console](https://www.twilio.com/console)
2. Use the free number your account comes with or [buy a new phone number](https://www.twilio.com/console/phone-numbers/incoming) (~$1.15/month)
3. Find your **Account SID** and **Auth Token** on the [Console Dashboard](https://www.twilio.com/console)

**Environment variables for Twilio:**
```bash
CALLME_PHONE_PROVIDER=twilio
CALLME_PHONE_ACCOUNT_SID=<Account SID>
CALLME_PHONE_AUTH_TOKEN=<Auth Token>
```

</details>

### 3. Set Environment Variables


Add these to `~/.claude/settings.json` (recommended) or export them in your shell:

```json
{
  "env": {
    "CALLME_PHONE_PROVIDER": "telnyx",
    "CALLME_PHONE_ACCOUNT_SID": "your-connection-id-or-account-sid",
    "CALLME_PHONE_AUTH_TOKEN": "your-api-key-or-auth-token",
    "CALLME_PHONE_NUMBER": "+15551234567",
    "CALLME_USER_PHONE_NUMBER": "+15559876543",
    "CALLME_OPENAI_API_KEY": "sk-...",
    "CALLME_NGROK_AUTHTOKEN": "your-ngrok-token"
  }
}
```

#### Required Variables

| Variable | Description |
|----------|-------------|
| `CALLME_PHONE_PROVIDER` | `telnyx` (default) or `twilio` |
| `CALLME_PHONE_ACCOUNT_SID` | Telnyx Connection ID or Twilio Account SID |
| `CALLME_PHONE_AUTH_TOKEN` | Telnyx API Key or Twilio Auth Token |
| `CALLME_PHONE_NUMBER` | Phone number Claude calls from (E.164 format) |
| `CALLME_USER_PHONE_NUMBER` | Your phone number to receive calls |
| `CALLME_OPENAI_API_KEY` | OpenAI API key (required for OpenAI STT/TTS; not required when using Telnyx for both STT and TTS) |
| `CALLME_NGROK_AUTHTOKEN` | ngrok auth token for webhook tunneling |

#### Optional Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CALLME_TTS_PROVIDER` | `openai` | TTS engine: `openai`, `kokoro` (free, local — see [Kokoro TTS](#kokoro-tts-free-local)), or `telnyx` (reuses Telnyx API key) |
| `CALLME_STT_PROVIDER` | `telnyx`* | STT engine: `openai-realtime` or `telnyx` (reuses Telnyx API key). *Defaults to `telnyx` when `CALLME_PHONE_PROVIDER=telnyx` |
| `CALLME_TTS_VOICE` | `onyx` / `af_bella` | Voice name (default depends on TTS provider) |
| `CALLME_KOKORO_URL` | - | URL of existing Kokoro instance (e.g. `http://localhost:8880/v1`). If unset, auto-starts Docker container |
| `CALLME_PORT` | `0` (auto) | Local HTTP server port (0 = OS picks a free port) |
| `CALLME_NGROK_DOMAIN` | - | Custom ngrok domain (paid feature) |
| `CALLME_TRANSCRIPT_TIMEOUT_MS` | `180000` | Timeout for user speech (3 minutes) |
| `CALLME_STT_SILENCE_DURATION_MS` | `800` | Silence duration to detect end of speech |
| `CALLME_TELNYX_PUBLIC_KEY` | - | Telnyx public key for webhook signature verification (recommended) |
| `CALLME_TELNYX_STT_ENGINE` | `Telnyx` | Telnyx STT engine: `Telnyx`, `Deepgram`, `Google`, or `Azure` |
| `CALLME_TELNYX_STT_INPUT_FORMAT` | `mulaw` | Telnyx STT audio format: `mulaw`, `linear16`, or `alaw` |
| `CALLME_TELNYX_STT_LANGUAGE` | `en-US` | Telnyx STT language (BCP-47 code) |
| `CALLME_TELNYX_TTS_VOICE` | `AWS.Polly.Matthew-Neural` | Telnyx TTS voice ID (see `/v2/text-to-speech/voices` for catalog) |
| `CALLME_TELNYX_API_KEY` | - | Telnyx API key for STT/TTS (defaults to `CALLME_PHONE_AUTH_TOKEN`) |

### 4. Install Plugin

```bash
/plugin marketplace add ZeframLou/call-me
/plugin install callme@callme
```

Restart Claude Code. Done!

---

## How It Works

```
Claude Code                    CallMe MCP Server (local)
    │                                    │
    │  "I finished the feature..."       │
    ▼                                    ▼
Plugin ────stdio──────────────────► MCP Server
                                         │
                                         ├─► ngrok tunnel
                                         │
                                         ▼
                                   Phone Provider (Telnyx/Twilio)
                                         │
                                         ▼
                                   Your Phone rings
                                   You speak
                                   Text returns to Claude
```

The MCP server runs locally and automatically creates an ngrok tunnel for phone provider webhooks.

---

## Tools

### `initiate_call`
Start a phone call.

```typescript
const { callId, response } = await initiate_call({
  message: "Hey! I finished the auth system. What should I work on next?"
});
```

### `continue_call`
Continue with follow-up questions.

```typescript
const response = await continue_call({
  call_id: callId,
  message: "Got it. Should I add rate limiting too?"
});
```

### `speak_to_user`
Speak to the user without waiting for a response. Useful for acknowledging requests before time-consuming operations.

```typescript
await speak_to_user({
  call_id: callId,
  message: "Let me search for that information. Give me a moment..."
});
// Continue with your long-running task
const results = await performSearch();
// Then continue the conversation
const response = await continue_call({
  call_id: callId,
  message: `I found ${results.length} results...`
});
```

### `end_call`
End the call.

```typescript
await end_call({
  call_id: callId,
  message: "Perfect, I'll get started. Talk soon!"
});
```

---

## Costs

| Service | Telnyx | Twilio |
|---------|--------|--------|
| Outbound calls | ~$0.007/min | ~$0.014/min |
| Phone number | ~$1/month | ~$1.15/month |

Plus API costs (same for both phone providers):
- **Speech-to-text**: ~$0.006/min (OpenAI gpt-4o-transcribe)
- **Text-to-speech**: ~$0.02/min (OpenAI TTS) or **free** with Kokoro

**Total**: ~$0.03-0.04/minute with OpenAI TTS, ~$0.01-0.02/minute with Kokoro

---

## Kokoro TTS (Free, Local)

[Kokoro](https://github.com/remsky/Kokoro-FastAPI) is a free, local text-to-speech engine that runs via Docker. No TTS API key needed — just set one env var (note: `CALLME_OPENAI_API_KEY` is still required if you use the OpenAI API for speech-to-text):

```bash
CALLME_TTS_PROVIDER=kokoro
```

**Auto-setup:** If Docker is installed and port 8880 is free, the plugin automatically pulls and starts the Kokoro container on first use.

**Existing instance:** If you already have Kokoro running (or want a custom port), point to it:

```bash
CALLME_TTS_PROVIDER=kokoro
CALLME_KOKORO_URL=http://localhost:8880/v1
```

**Voices:** Kokoro has different voices than OpenAI. Query available voices at `http://localhost:8880/v1/audio/voices`. Popular choices: `af_bella`, `af_sky`, `am_adam`. Set with `CALLME_TTS_VOICE`.

**Requirements:** Docker (for auto-setup) or an existing Kokoro instance.

---

## Troubleshooting

### Claude doesn't use the tool
1. Check all required environment variables are set (ideally in `~/.claude/settings.json`)
2. Restart Claude Code after installing the plugin
3. Try explicitly: "Call me to discuss the next steps when you're done."

### Call doesn't connect
1. Check the MCP server logs (stderr) with `claude --debug`
2. Verify your phone provider credentials are correct
3. Make sure ngrok can create a tunnel

### Audio issues
1. Ensure your phone number is verified with your provider
2. Check that the webhook URL in your provider dashboard matches your ngrok URL

### ngrok errors
1. Verify your `CALLME_NGROK_AUTHTOKEN` is correct
2. Check if you've hit ngrok's free tier limits
3. Try a different port with `CALLME_PORT=3334`

---

## Development

```bash
cd server
bun install
bun run dev
```

---

## License

MIT
