# CallMe

**Minimal plugin that lets Claude Code call you on the phone or message you via Slack.**

Start a task, walk away. Your phone/watch rings (or Slack notifies you) when Claude is done, stuck, or needs a decision.

<img src="./call-me-comic-min.png" width="800" alt="CallMe comic strip">

- **Two modes** - Phone calls for voice, Slack DMs for text-based chat
- **Multi-turn conversations** - Talk through decisions naturally
- **Works anywhere** - Smartphone, smartwatch, Slack on any device
- **Tool-use composable** - Claude can e.g. do a web search while on a call with you

---

## Choose Your Mode

| Mode | Cost | Setup Time | Best For |
|------|------|------------|----------|
| **Slack** | Free | 2 minutes | Text-based, code snippets, at your computer |
| **Phone** | ~$0.03/min | 10 minutes | Voice, hands-free, away from computer |

---

## Quick Start: Slack (Free, Recommended)

### 1. Create a Slack App (2 minutes)

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Name it (e.g., "Claude CallMe") and select your workspace

### 2. Configure the App

<details>
<summary><b>Enable Socket Mode</b></summary>

1. Go to **Socket Mode** in the sidebar
2. Toggle **Enable Socket Mode** ON
3. Create an app-level token with `connections:write` scope
4. Copy the token (starts with `xapp-...`)

</details>

<details>
<summary><b>Add Bot Permissions</b></summary>

1. Go to **OAuth & Permissions** in the sidebar
2. Under **Scopes** → **Bot Token Scopes**, add:
   - `chat:write` - Send messages
   - `im:history` - Read DM history
   - `im:read` - Access DM information
   - `im:write` - Open DM conversations
   - `users:read` - Get user information

</details>

<details>
<summary><b>Subscribe to Events</b></summary>

1. Go to **Event Subscriptions** in the sidebar
2. Toggle **Enable Events** ON
3. Under **Subscribe to bot events**, add:
   - `message.im` - Receive direct messages

</details>

<details>
<summary><b>Install the App</b></summary>

1. Go to **Install App** in the sidebar
2. Click **Install to Workspace** and authorize
3. Copy the **Bot User OAuth Token** (starts with `xoxb-...`)

</details>

### 3. Get Your Slack User ID

1. Open Slack
2. Click your profile picture → **Profile**
3. Click the **⋮** menu → **Copy member ID**

### 4. Set Environment Variables

Add to `~/.claude/settings.json`:

```json
{
  "env": {
    "CALLME_SLACK_BOT_TOKEN": "xoxb-your-bot-token",
    "CALLME_SLACK_APP_TOKEN": "xapp-your-app-token",
    "CALLME_SLACK_USER_ID": "U12345678"
  }
}
```

### 5. Install Plugin

```bash
/plugin marketplace add ZeframLou/call-me
/plugin install callme@callme-slack
```

Restart Claude Code. Done!

---

## Quick Start: Phone

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

#### Required Variables (Phone Mode)

| Variable | Description |
|----------|-------------|
| `CALLME_PHONE_PROVIDER` | `telnyx` (default) or `twilio` |
| `CALLME_PHONE_ACCOUNT_SID` | Telnyx Connection ID or Twilio Account SID |
| `CALLME_PHONE_AUTH_TOKEN` | Telnyx API Key or Twilio Auth Token |
| `CALLME_PHONE_NUMBER` | Phone number Claude calls from (E.164 format) |
| `CALLME_USER_PHONE_NUMBER` | Your phone number to receive calls |
| `CALLME_OPENAI_API_KEY` | OpenAI API key (for TTS and realtime STT) |
| `CALLME_NGROK_AUTHTOKEN` | ngrok auth token for webhook tunneling |

#### Optional Variables (Phone Mode)

| Variable | Default | Description |
|----------|---------|-------------|
| `CALLME_TTS_VOICE` | `onyx` | OpenAI voice: alloy, echo, fable, onyx, nova, shimmer |
| `CALLME_PORT` | `3333` | Local HTTP server port |
| `CALLME_NGROK_DOMAIN` | - | Custom ngrok domain (paid feature) |
| `CALLME_TRANSCRIPT_TIMEOUT_MS` | `180000` | Timeout for user speech (3 minutes) |
| `CALLME_STT_SILENCE_DURATION_MS` | `800` | Silence duration to detect end of speech |
| `CALLME_TELNYX_PUBLIC_KEY` | - | Telnyx public key for webhook signature verification (recommended) |

### 4. Install Plugin

```bash
/plugin marketplace add ZeframLou/call-me
/plugin install callme@callme
```

Restart Claude Code. Done!

---

## How It Works

### Phone Mode

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

### Slack Mode

[Slack Mode Comic](./futuristic-slack-comic.png)

```
Claude Code                    CallMe Slack MCP Server (local)
    │                                    │
    │  "I finished the feature..."       │
    ▼                                    ▼
Plugin ────stdio──────────────────► MCP Server
                                         │
                                         ├─► Socket Mode (WebSocket)
                                         │
                                         ▼
                                   Slack API
                                         │
                                         ▼
                                   Your Slack DM
                                   You type response
                                   Text returns to Claude
```

The Slack mode uses Socket Mode - no ngrok or public webhooks needed!

---

## Tools

### Phone Mode Tools

#### `initiate_call`
Start a phone call.

```typescript
const { callId, response } = await initiate_call({
  message: "Hey! I finished the auth system. What should I work on next?"
});
```

#### `continue_call`
Continue with follow-up questions.

```typescript
const response = await continue_call({
  call_id: callId,
  message: "Got it. Should I add rate limiting too?"
});
```

#### `speak_to_user`
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

#### `end_call`
End the call.

```typescript
await end_call({
  call_id: callId,
  message: "Perfect, I'll get started. Talk soon!"
});
```

### Slack Mode Tools

#### `send_message`
Start a Slack DM conversation.

```typescript
const { chatId, response } = await send_message({
  message: "Hey! I finished the auth system. What should I work on next?"
});
```

#### `continue_chat`
Continue with follow-up questions.

```typescript
const response = await continue_chat({
  chat_id: chatId,
  message: "Got it. Should I add rate limiting too?"
});
```

#### `notify_user`
Send a notification without waiting for response.

```typescript
await notify_user({
  chat_id: chatId,
  message: "Let me search for that. Give me a moment..."
});
```

#### `end_chat`
End the conversation.

```typescript
await end_chat({
  chat_id: chatId,
  message: "Perfect, I'll get started. I'll message you when done!"
});
```

---

## Costs

### Phone Mode

| Service | Telnyx | Twilio |
|---------|--------|--------|
| Outbound calls | ~$0.007/min | ~$0.014/min |
| Phone number | ~$1/month | ~$1.15/month |

Plus OpenAI costs (same for both providers):
- **Speech-to-text**: ~$0.006/min (Whisper)
- **Text-to-speech**: ~$0.02/min (TTS)

**Total**: ~$0.03-0.04/minute of conversation

### Slack Mode

**Free!** No external API costs.

---

## Troubleshooting

### Claude doesn't use the tool
1. Check all required environment variables are set (ideally in `~/.claude/settings.json`)
2. Restart Claude Code after installing the plugin
3. Try explicitly: "Call me to discuss the next steps when you're done." or "Message me on Slack..."

### Phone: Call doesn't connect
1. Check the MCP server logs (stderr) with `claude --debug`
2. Verify your phone provider credentials are correct
3. Make sure ngrok can create a tunnel

### Phone: Audio issues
1. Ensure your phone number is verified with your provider
2. Check that the webhook URL in your provider dashboard matches your ngrok URL

### Phone: ngrok errors
1. Verify your `CALLME_NGROK_AUTHTOKEN` is correct
2. Check if you've hit ngrok's free tier limits
3. Try a different port with `CALLME_PORT=3334`

### Slack: Messages not received
1. Check that Socket Mode is enabled in your Slack app
2. Verify the app is installed to your workspace
3. Ensure you've subscribed to `message.im` bot event
4. Check that your `CALLME_SLACK_USER_ID` is correct (should start with `U`)

### Slack: Connection drops
1. Socket Mode connections can occasionally drop - the server automatically reconnects
2. Check your `CALLME_SLACK_APP_TOKEN` is valid
3. Try restarting Claude Code

---

## Development

```bash
cd server
bun install

# Phone mode
bun run dev

# Slack mode
bun run dev:slack
```

---

## Environment Variables Reference

### Slack Mode

| Variable | Required | Description |
|----------|----------|-------------|
| `CALLME_SLACK_BOT_TOKEN` | Yes | Bot User OAuth Token (`xoxb-...`) |
| `CALLME_SLACK_APP_TOKEN` | Yes | App-Level Token for Socket Mode (`xapp-...`) |
| `CALLME_SLACK_USER_ID` | Yes | Your Slack member ID (`U...`) |
| `CALLME_SLACK_RESPONSE_TIMEOUT_MS` | No | Response timeout (default: 300000 = 5 minutes) |

### Phone Mode

| Variable | Required | Description |
|----------|----------|-------------|
| `CALLME_PHONE_PROVIDER` | Yes | `telnyx` or `twilio` |
| `CALLME_PHONE_ACCOUNT_SID` | Yes | Provider credentials |
| `CALLME_PHONE_AUTH_TOKEN` | Yes | Provider credentials |
| `CALLME_PHONE_NUMBER` | Yes | Phone number to call from |
| `CALLME_USER_PHONE_NUMBER` | Yes | Your phone number |
| `CALLME_OPENAI_API_KEY` | Yes | For TTS/STT |
| `CALLME_NGROK_AUTHTOKEN` | Yes | For webhook tunneling |
| `CALLME_TTS_VOICE` | No | OpenAI voice (default: `onyx`) |
| `CALLME_PORT` | No | HTTP server port (default: `3333`) |
| `CALLME_NGROK_DOMAIN` | No | Custom ngrok domain |
| `CALLME_TRANSCRIPT_TIMEOUT_MS` | No | Speech timeout (default: `180000`) |
| `CALLME_STT_SILENCE_DURATION_MS` | No | Silence detection (default: `800`) |
| `CALLME_TELNYX_PUBLIC_KEY` | No | Webhook signature verification |

---

## License

MIT
