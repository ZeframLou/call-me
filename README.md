# CallMe

**Minimal plugin that lets Claude Code call you on the phone or message you on Telegram.**

Start a task, walk away. Your phone rings (or Telegram pings) when Claude is done, stuck, or needs a decision.

<img src="./call-me-comic-min.png" width="800" alt="CallMe comic strip">

- **Two modes** - Phone calls (voice) or Telegram (text) - your choice!
- **Multi-turn conversations** - Talk through decisions naturally.
- **Works anywhere** - Smartphone, smartwatch, landline, or Telegram!
- **Tool-use composable** - Claude can e.g. do a web search while on a call/chat with you.

---

## Quick Start

Choose your mode:

| Mode | Cost | Setup Time | Best For |
|------|------|------------|----------|
| **Telegram** | Free | 2 minutes | Text-based, quick responses |
| **Phone** | ~$0.03/min | 10 minutes | Voice, hands-free, away from computer |

---

## Option A: Telegram Mode (Recommended for Quick Start)

### 1. Create a Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Copy the **bot token** (looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

### 2. Get Your Chat ID

1. Message [@userinfobot](https://t.me/userinfobot) on Telegram
2. Copy your **user ID** (a number like `123456789`)

### 3. Configure MCP Server

Add to `~/.claude.json` (create if it doesn't exist):

```json
{
  "mcpServers": {
    "callme-telegram": {
      "type": "stdio",
      "command": "bunx",
      "args": ["--bun", "callme-mcp@latest", "telegram"],
      "env": {
        "CALLME_TELEGRAM_BOT_TOKEN": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
        "CALLME_TELEGRAM_CHAT_ID": "123456789"
      }
    }
  }
}
```

**Optional**: Add these env vars for extra features:
```json
"env": {
  ...
  "CALLME_TELEGRAM_VERBOSE": "true",
  "CALLME_TELEGRAM_LISTEN": "true"
}
```
- `CALLME_TELEGRAM_VERBOSE` - Stream all Claude output to Telegram
- `CALLME_TELEGRAM_LISTEN` - Enable two-way communication (send tasks via Telegram)

### 4. Restart Claude Code

Run `/mcp` to verify `callme-telegram` is connected. Done!

---

## Option B: Phone Mode

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

### 3. Configure MCP Server

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "callme": {
      "type": "stdio",
      "command": "bunx",
      "args": ["--bun", "callme-mcp@latest"],
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
| `CALLME_TELNYX_PUBLIC_KEY` | - | Telnyx public key for webhook signature verification (recommended) |

### 4. Restart Claude Code

Run `/mcp` to verify `callme` is connected. Done!

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

## Telegram Tools

### `broadcast`
Send a one-way message without waiting for response or managing chat state. Perfect for status updates and streaming output.

```typescript
await broadcast({
  message: "Starting to analyze the codebase..."
});
```

**Verbose Mode**: Set `CALLME_TELEGRAM_VERBOSE=true` or use `/verbose on` in Telegram to enable streaming mode.

### `send_message`
Start a Telegram conversation.

```typescript
const { chatId, response } = await send_message({
  message: "Hey! I finished the auth system. What should I work on next?"
});
```

### `continue_chat`
Continue with follow-up questions.

```typescript
const response = await continue_chat({
  chat_id: chatId,
  message: "Got it. Should I add rate limiting too?"
});
```

### `notify_user`
Send a message without waiting for response.

```typescript
await notify_user({
  chat_id: chatId,
  message: "Let me search for that information..."
});
```

### `end_chat`
End the conversation.

```typescript
await end_chat({
  chat_id: chatId,
  message: "Perfect, I'll get started. Talk soon!"
});
```

### `listen_for_commands`
Wait for the user to send a task via Telegram (requires `CALLME_TELEGRAM_LISTEN=true`).

```typescript
// Tell Claude: "Listen for my commands via Telegram"
const command = await listen_for_commands({
  prompt: "Ready for your next task!"
});
// Claude receives: "Find all TODOs in the code"
// Claude executes the task, broadcasts progress, then listens again
```

### Telegram Slash Commands

Control the bot anytime from Telegram:

| Command | Description |
|---------|-------------|
| `/verbose on` | Enable verbose mode (stream all output) |
| `/verbose off` | Disable verbose mode |
| `/verbose` | Show current verbose mode status |
| `/help` | Show available commands |

---

## Phone Tools

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

Plus OpenAI costs (same for both providers):
- **Speech-to-text**: ~$0.006/min (Whisper)
- **Text-to-speech**: ~$0.02/min (TTS)

**Total**: ~$0.03-0.04/minute of conversation

---

## Troubleshooting

### Claude doesn't use the tool
1. Run `/mcp` to verify the MCP server is connected
2. Check all required environment variables are set in `~/.claude.json`
3. Restart Claude Code after configuration changes
4. Try explicitly: "Call me to discuss the next steps when you're done."

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
