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
- **Tunnel provider** (one of):
  - [ngrok](https://ngrok.com) - Free account required (default)
  - [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) - No account required for quick tunnels

### 2. Set Up Phone Provider

Choose **one** of the following:

<details>
<summary><b>Option A: Telnyx (Recommended - 50% cheaper)</b></summary>

1. Create account at [portal.telnyx.com](https://portal.telnyx.com) and verify your identity
2. [Buy a phone number](https://portal.telnyx.com/#/numbers/buy-numbers) with Voice capability (~$1/month)
3. **Verify your personal phone number** at [Verified Numbers](https://portal.telnyx.com/#/numbers/verified-numbers)
   - This is required for new accounts - calls to unverified numbers will fail
4. [Create a Voice API application](https://portal.telnyx.com/#/call-control/applications):
   - **Webhook URL**: `https://your-tunnel-url/twiml` (set up tunnel first, see Step 3)
   - **API Version**: v2
   - Save and note your **Application ID**
5. Assign your purchased phone number to this application (Numbers → My Numbers → select number → Voice → Connection)
6. Get your **API Key** from Account → Keys & Credentials

**Environment variables:**
```bash
CALLME_PHONE_PROVIDER=telnyx
CALLME_PHONE_ACCOUNT_SID=<Application ID>
CALLME_PHONE_AUTH_TOKEN=<API Key>
CALLME_TELNYX_PUBLIC_KEY=<Public Key>  # Optional: webhook signature verification
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

### 3. Set Up Tunnel Provider

Choose **one** of the following for exposing webhooks to phone providers:

<details>
<summary><b>Option A: ngrok (Default)</b></summary>

1. Create free account at [ngrok.com](https://ngrok.com)
2. Get your auth token from [dashboard.ngrok.com](https://dashboard.ngrok.com/get-started/your-authtoken)

```bash
CALLME_NGROK_AUTHTOKEN=your-ngrok-token
# Optional: custom domain for stable URL (paid ngrok feature)
CALLME_NGROK_DOMAIN=your-domain.ngrok.io
```

> **Note:** Free tier URLs change on every restart. You'll need to update your phone provider webhook each time, or use a paid ngrok domain / Cloudflare named tunnel for a stable URL.

</details>

<details>
<summary><b>Option B: Cloudflare Tunnel</b></summary>

Install cloudflared CLI:
- **macOS**: `brew install cloudflared`
- **Linux**: See [Cloudflare downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
- **Windows**: `winget install Cloudflare.cloudflared`

#### Quick Tunnel (No account required)

Fastest way to get started. URL changes each restart.

```bash
CALLME_TUNNEL_PROVIDER=cloudflare
```

#### Named Tunnel (Recommended for production)

Stable URL that never changes - set webhook once and forget.

**Requirements:** Cloudflare account + domain on Cloudflare

**Setup:**
```bash
# 1. Authenticate (opens browser)
cloudflared tunnel login

# 2. Create tunnel
cloudflared tunnel create callme

# 3. Route your subdomain to the tunnel
cloudflared tunnel route dns callme callme.yourdomain.com

# 4. Create config file at ~/.cloudflared/config.yml
```

**Config file** (`~/.cloudflared/config.yml`):
```yaml
tunnel: <TUNNEL_ID_FROM_STEP_2>
credentials-file: /path/to/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: callme.yourdomain.com
    service: http://localhost:3333
  - service: http_status:404
```

**Environment variables:**
```bash
CALLME_TUNNEL_PROVIDER=cloudflare
CALLME_CLOUDFLARE_TUNNEL_NAME=callme
CALLME_CLOUDFLARE_TUNNEL_DOMAIN=callme.yourdomain.com
```

Your webhook URL will be `https://callme.yourdomain.com/twiml`

See [Cloudflare Tunnel docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/) for detailed setup.

</details>

### 4. Set Environment Variables

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
| `CALLME_PHONE_ACCOUNT_SID` | Telnyx Application ID or Twilio Account SID |
| `CALLME_PHONE_AUTH_TOKEN` | Telnyx API Key or Twilio Auth Token |
| `CALLME_PHONE_NUMBER` | Phone number Claude calls from (E.164 format, e.g., +15551234567) |
| `CALLME_USER_PHONE_NUMBER` | Your phone number to receive calls (must be verified for Telnyx) |
| `CALLME_OPENAI_API_KEY` | OpenAI API key for TTS and STT |
| `CALLME_NGROK_AUTHTOKEN` | ngrok auth token (only required if using ngrok) |

#### Optional Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CALLME_TUNNEL_PROVIDER` | `ngrok` | Tunnel provider: `ngrok` or `cloudflare` |
| `CALLME_TTS_VOICE` | `onyx` | OpenAI voice: alloy, echo, fable, onyx, nova, shimmer |
| `CALLME_PORT` | `3333` | Local HTTP server port |
| `CALLME_NGROK_DOMAIN` | - | Custom ngrok domain (paid feature) |
| `CALLME_CLOUDFLARE_TUNNEL_NAME` | - | Named Cloudflare tunnel (requires pre-configuration) |
| `CALLME_CLOUDFLARE_TUNNEL_DOMAIN` | - | Domain for named Cloudflare tunnel |
| `CALLME_TRANSCRIPT_TIMEOUT_MS` | `180000` | Timeout for user speech (3 minutes) |
| `CALLME_STT_SILENCE_DURATION_MS` | `800` | Silence duration to detect end of speech |
| `CALLME_TELNYX_PUBLIC_KEY` | - | Telnyx public key for webhook signature verification (recommended) |

### 5. Install Plugin

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
                                         ├─► Tunnel (ngrok/Cloudflare)
                                         │
                                         ▼
                                   Phone Provider (Telnyx/Twilio)
                                         │
                                         ▼
                                   Your Phone rings
                                   You speak
                                   Text returns to Claude
```

The MCP server runs locally and automatically creates a tunnel (ngrok or Cloudflare) for phone provider webhooks.

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
1. **Telnyx**: Verify your personal phone number is added at [Verified Numbers](https://portal.telnyx.com/#/numbers/verified-numbers) - new accounts can only call verified numbers
2. Check the MCP server logs (stderr) with `claude --debug`
3. Verify your phone provider credentials are correct
4. Make sure your tunnel is running and accessible

### Audio issues
1. Ensure your phone number is verified with your provider
2. Check that the webhook URL in your provider dashboard matches your tunnel URL

### ngrok errors
1. Verify your `CALLME_NGROK_AUTHTOKEN` is correct
2. Check if you've hit ngrok's free tier limits
3. Try a different port with `CALLME_PORT=3334`

### Cloudflare Tunnel errors
1. Ensure `cloudflared` CLI is installed: `cloudflared --version`
2. For named tunnels, verify tunnel is created in Cloudflare dashboard
3. Check that `CALLME_CLOUDFLARE_TUNNEL_DOMAIN` matches your tunnel configuration
4. Try quick tunnel mode first (no `CALLME_CLOUDFLARE_TUNNEL_NAME`)

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
