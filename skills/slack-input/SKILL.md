# Slack Chat Input Skill

## Description
Message the user via Slack DMs for text-based conversations. A free alternative to phone calls that works without any external webhooks or ngrok.

## When to Use This Skill

**Use when:**
- You've **completed a significant task** and want to report status and ask what's next
- You need **text-based input** for decisions that don't require voice
- A question requires **back-and-forth discussion** to fully understand
- You're **blocked** and need clarification to proceed
- You want to share **code snippets, links, or formatted content** (Slack supports markdown)
- The user is **at their computer** and prefers reading over phone calls

**Do NOT use for:**
- Simple yes/no questions (use text instead)
- Urgent matters when the user is away from computer (use phone call instead)
- Information the user has already provided

## Comparison with Phone Calls

| Feature | Slack | Phone |
|---------|-------|-------|
| **Cost** | Free | ~$0.03/min |
| **Setup time** | 2 minutes | 10 minutes |
| **Requires ngrok** | No | Yes |
| **Best for** | Text, code, links | Voice, hands-free |
| **Rich formatting** | Yes (markdown) | No |
| **Response speed** | Depends on user | Immediate |

## Tools

### `send_message`
Start a Slack DM conversation with the user.

**Parameters:**
- `message` (string): What you want to say. Supports Slack markdown formatting.

**Returns:**
- Chat ID and the user's response

### `continue_chat`
Continue an active chat with a follow-up message.

**Parameters:**
- `chat_id` (string): The chat ID from `send_message`
- `message` (string): Your follow-up message

**Returns:**
- The user's response

### `notify_user`
Send a one-way notification without waiting for response. Use for status updates or acknowledgments before long operations.

**Parameters:**
- `chat_id` (string): The chat ID from `send_message`
- `message` (string): What to say to the user

**Returns:**
- Confirmation that the message was sent

**When to use:**
- Acknowledge a request before starting a long operation (e.g., "Let me search for that...")
- Provide status updates during multi-step tasks
- Keep the conversation flowing naturally

### `end_chat`
End an active chat with a closing message.

**Parameters:**
- `chat_id` (string): The chat ID from `send_message`
- `message` (string): Your closing message

**Returns:**
- Chat duration in seconds

## Example Usage

**Simple conversation:**
```
1. send_message: "Hey! I finished the auth system. Should I move on to the API endpoints?"
2. User responds: "Yes, go ahead"
3. end_chat: "Perfect! I'll start on the API endpoints. I'll message you when it's ready!"
```

**Multi-turn conversation:**
```
1. send_message: "I'm working on payments. Should I use Stripe or PayPal?"
2. User: "Use Stripe"
3. continue_chat: "Got it. Do you want the full checkout flow or just a simple button?"
4. User: "Full checkout flow"
5. end_chat: "Awesome, I'll build the full Stripe checkout. I'll let you know when it's ready!"
```

**Using notify_user for long operations:**
```
1. send_message: "Hey! I finished the database migration. What should I work on next?"
2. User: "Can you look up the latest API documentation for Stripe?"
3. notify_user: "Sure! Let me search for that. Give me a moment..."
4. [Perform web search and gather information]
5. continue_chat: "I found the latest Stripe API docs. They released v2024.1 with new payment methods..."
6. User: "Great, implement that"
7. end_chat: "Perfect! I'll implement the new payment methods. I'll message you when done!"
```

**Sharing code or formatted content:**
```
1. send_message: "I found an issue with the auth middleware. Here's the problematic code:\n\n```javascript\nconst token = req.headers.authorization;\nif (!token) return res.status(401).send('Unauthorized');\n```\n\nShould I add proper Bearer token parsing?"
2. User: "Yes, please fix it"
3. end_chat: "Done! I've updated the middleware to properly parse Bearer tokens. :white_check_mark:"
```

## Best Practices

1. **Be conversational** - Write naturally, like you're messaging a colleague
2. **Provide context** - Explain what you've done before asking questions
3. **Offer clear options** - Make decisions easy with specific choices
4. **Use Slack formatting** - Leverage markdown for code blocks, bold text, and bullet points
5. **Use notify_user for acknowledgments** - Before time-consuming operations, let the user know what you're doing
6. **Always end gracefully** - Say goodbye and state what you'll do next
7. **Consider response time** - Users may not respond immediately, be patient

## Setup

1. Create a Slack app at https://api.slack.com/apps
2. Enable Socket Mode under "Socket Mode"
3. Add these OAuth Bot Token Scopes:
   - `chat:write` - Send messages
   - `im:history` - Read DM history
   - `im:read` - Access DM information
   - `im:write` - Open DM conversations
   - `users:read` - Get user information
4. Subscribe to bot events:
   - `message.im` - Receive DM messages
5. Install app to workspace and copy Bot Token (`xoxb-...`)
6. Generate App-Level Token with `connections:write` scope (`xapp-...`)
7. Get your Slack User ID (Profile > ⋮ > Copy member ID)

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CALLME_SLACK_BOT_TOKEN` | Bot User OAuth Token (starts with `xoxb-`) |
| `CALLME_SLACK_APP_TOKEN` | App-Level Token for Socket Mode (starts with `xapp-`) |
| `CALLME_SLACK_USER_ID` | Your Slack member ID (starts with `U`) |
| `CALLME_SLACK_RESPONSE_TIMEOUT_MS` | Response timeout in ms (default: 300000 = 5 minutes) |
