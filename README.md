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
- **OpenAI API key**: For speech-to-text and text-to-speech
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
| `CALLME_OPENAI_API_KEY` | OpenAI API key (for TTS and realtime STT) |
| `CALLME_NGROK_AUTHTOKEN` | ngrok auth token for webhook tunneling |

#### Optional Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CALLME_TTS_VOICE` | `onyx` | OpenAI voice: alloy, echo, fable, onyx, nova, shimmer |
| `CALLME_PORT` | `3333` | Local HTTP server port |
| `CALLME_NGROK_DOMAIN` | - | Custom ngrok domain (paid feature) |
| `CALLME_TRANSCRIPT_TIMEOUT_MS` | `180000` | Timeout for user speech (3 minutes) |
| `CALLME_STT_SILENCE_DURATION_MS` | `800` | Silence duration to detect end of speech |
| `CALLME_STT_LANGUAGE` | - | Language code for STT (ISO-639-1: en, fr, es, de, etc.) |
| `CALLME_TELNYX_PUBLIC_KEY` | - | Telnyx public key for webhook signature verification (recommended) |

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

## Incoming Call Support

CallMe can also receive incoming calls! When you call the configured phone number:
- The call is automatically answered
- Claude immediately starts listening (no greeting message)
- Use `list_active_calls` to discover the incoming call
- Use `continue_call` to respond to the user
- Use `end_call` to hang up

### Configuration

Incoming calls are enabled by default. To disable:

```bash
CALLME_ENABLE_INCOMING_CALLS=false
```

To restrict incoming calls to specific numbers:

```bash
CALLME_ALLOWED_CALLERS=+15559876543,+15551112222
```

By default, only the number in `CALLME_USER_PHONE_NUMBER` can call.

### Provider Setup

**Telnyx:**
- Ensure your Telnyx phone number is configured to receive incoming calls
- The webhook URL must be set in your Telnyx Voice Application settings

**Twilio:**
- Configure your Twilio phone number's voice URL to your ngrok webhook
- Ensure the webhook is set to handle incoming voice calls

### Usage Example

1. Call your configured phone number from your verified number
2. The call is automatically answered
3. Speak your instruction to Claude
4. Use the `list_active_calls` tool in Claude Code to see the incoming call
5. Use `continue_call` with the call ID to respond

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

### `list_active_calls`
List all active phone calls (both outbound and incoming). Use this to discover incoming calls from users.

```typescript
const { activeCalls } = await list_active_calls();
// Returns:
// {
//   activeCalls: [
//     {
//       callId: 'call-1-1234567890',
//       direction: 'outbound',
//       userPhoneNumber: '+15559876543',
//       startTime: '2025-01-08T10:30:00Z',
//       durationSeconds: 45
//     },
//     {
//       callId: 'call-inbound-2-1234567891',
//       direction: 'inbound',
//       userPhoneNumber: '+15551112222',
//       startTime: '2025-01-08T10:31:00Z',
//       durationSeconds: 30
//     }
//   ]
// }
```

---

## Multilingual Support

CallMe supports multiple languages for speech recognition and synthesis.

### Speech-to-Text (STT) Language Configuration

The speech recognition service (OpenAI Realtime API) supports multiple languages. You can specify the language to improve transcription accuracy and reduce latency.

**Environment Variable:**
```bash
CALLME_STT_LANGUAGE=fr  # ISO-639-1 language code
```

**Supported Languages:**
- `en` - English
- `fr` - French
- `es` - Spanish
- `de` - German
- `it` - Italian
- `pt` - Portuguese
- `zh` - Chinese
- `ja` - Japanese
- `ko` - Korean
- `ru` - Russian
- And more...

**Behavior:**
- If not specified, OpenAI will auto-detect the language (slower, less accurate)
- Specifying a language improves transcription accuracy
- Reduces latency by skipping language detection step

**Example Configuration (French):**
```json
{
  "env": {
    "CALLME_OPENAI_API_KEY": "sk-...",
    "CALLME_STT_LANGUAGE": "fr"
  }
}
```

### Text-to-Speech (TTS) Voices

**Default (OpenAI TTS):**
- Supports English voices only
- Available voices: alloy, echo, fable, onyx, nova, shimmer
- Configured via `CALLME_TTS_VOICE`

**For multilingual TTS support, Amazon Polly is available as an alternative provider.**

See [Amazon Polly TTS Setup](#amazon-polly-tts-setup) below for details on using French or other languages.

---

## Costs

| Service | Telnyx | Twilio |
|---------|--------|--------|
| Outbound calls | ~$0.007/min | ~$0.014/min |
| Phone number | ~$1/month | ~$1.15/month |

Plus OpenAI costs (same for both providers):
- **Speech-to-text**: ~$0.006/min (Whisper)
- **Text-to-speech**: ~$0.02/min (TTS)

**Total**: ~$0.03-0.04/minute of conversation

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
