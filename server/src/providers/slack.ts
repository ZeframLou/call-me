/**
 * Slack Messaging Provider
 *
 * Uses Slack's Web API and Socket Mode for real-time messaging.
 * This is a text-based alternative to phone calls - free and no ngrok required.
 *
 * Setup:
 * 1. Create a Slack App at https://api.slack.com/apps
 * 2. Enable Socket Mode under "Socket Mode"
 * 3. Add OAuth scopes: chat:write, im:history, im:read, im:write, users:read
 * 4. Install app to workspace and get Bot Token (xoxb-...)
 * 5. Generate App-Level Token with connections:write scope (xapp-...)
 * 6. Get your Slack User ID (click profile > copy member ID)
 */

export interface SlackConfig {
  botToken: string;      // xoxb-... token
  appToken: string;      // xapp-... token for Socket Mode
  userSlackId: string;   // Slack user ID to message (U...)
}

export interface SlackMessage {
  ts: string;           // Slack message timestamp (unique ID)
  text: string;         // Message content
  user: string;         // User ID who sent the message
  channel: string;      // Channel/DM ID
}

/**
 * Slack Provider - handles sending messages and receiving responses via Socket Mode
 */
export class SlackProvider {
  readonly name = 'slack';
  private botToken: string | null = null;
  private appToken: string | null = null;
  private userSlackId: string | null = null;
  private dmChannelId: string | null = null;

  initialize(config: SlackConfig): void {
    this.botToken = config.botToken;
    this.appToken = config.appToken;
    this.userSlackId = config.userSlackId;
    console.error(`[Slack] Provider initialized`);
  }

  /**
   * Open or get existing DM channel with user
   */
  async openDMChannel(): Promise<string> {
    if (!this.botToken || !this.userSlackId) {
      throw new Error('Slack not initialized');
    }

    // Return cached channel if available
    if (this.dmChannelId) {
      return this.dmChannelId;
    }

    const response = await fetch('https://slack.com/api/conversations.open', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        users: this.userSlackId,
      }),
    });

    const data = await response.json() as {
      ok: boolean;
      channel?: { id: string };
      error?: string;
    };

    if (!data.ok || !data.channel) {
      throw new Error(`Failed to open DM channel: ${data.error || 'Unknown error'}`);
    }

    this.dmChannelId = data.channel.id;
    console.error(`[Slack] DM channel opened: ${this.dmChannelId}`);
    return this.dmChannelId;
  }

  /**
   * Send a message to the user
   */
  async sendMessage(text: string, channelId?: string): Promise<string> {
    if (!this.botToken) {
      throw new Error('Slack not initialized');
    }

    const channel = channelId || await this.openDMChannel();

    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel,
        text,
        // Use mrkdwn for formatting support
        mrkdwn: true,
      }),
    });

    const data = await response.json() as {
      ok: boolean;
      ts?: string;
      error?: string;
    };

    if (!data.ok || !data.ts) {
      throw new Error(`Failed to send message: ${data.error || 'Unknown error'}`);
    }

    return data.ts;
  }

  /**
   * Get messages from a channel since a specific timestamp
   * Used for polling-based message retrieval
   */
  async getMessagesSince(channelId: string, oldestTs: string): Promise<SlackMessage[]> {
    if (!this.botToken) {
      throw new Error('Slack not initialized');
    }

    const params = new URLSearchParams({
      channel: channelId,
      oldest: oldestTs,
      inclusive: 'false',
      limit: '100',
    });

    const response = await fetch(
      `https://slack.com/api/conversations.history?${params}`,
      {
        headers: {
          'Authorization': `Bearer ${this.botToken}`,
        },
      }
    );

    const data = await response.json() as {
      ok: boolean;
      messages?: Array<{
        ts: string;
        text: string;
        user?: string;
        bot_id?: string;
      }>;
      error?: string;
    };

    if (!data.ok) {
      throw new Error(`Failed to get messages: ${data.error || 'Unknown error'}`);
    }

    // Filter out bot messages (only return user messages)
    return (data.messages || [])
      .filter((msg) => msg.user && !msg.bot_id)
      .map((msg) => ({
        ts: msg.ts,
        text: msg.text,
        user: msg.user!,
        channel: channelId,
      }))
      .reverse(); // Return in chronological order
  }

  /**
   * Get the app token for Socket Mode connections
   */
  getAppToken(): string {
    if (!this.appToken) {
      throw new Error('Slack not initialized');
    }
    return this.appToken;
  }

  /**
   * Get bot token for API calls
   */
  getBotToken(): string {
    if (!this.botToken) {
      throw new Error('Slack not initialized');
    }
    return this.botToken;
  }

  /**
   * Get the configured user's Slack ID
   */
  getUserSlackId(): string {
    if (!this.userSlackId) {
      throw new Error('Slack not initialized');
    }
    return this.userSlackId;
  }

  /**
   * Get user info by ID
   */
  async getUserInfo(userId: string): Promise<{ name: string; realName: string }> {
    if (!this.botToken) {
      throw new Error('Slack not initialized');
    }

    const response = await fetch(
      `https://slack.com/api/users.info?user=${userId}`,
      {
        headers: {
          'Authorization': `Bearer ${this.botToken}`,
        },
      }
    );

    const data = await response.json() as {
      ok: boolean;
      user?: {
        name: string;
        real_name: string;
      };
      error?: string;
    };

    if (!data.ok || !data.user) {
      throw new Error(`Failed to get user info: ${data.error || 'Unknown error'}`);
    }

    return {
      name: data.user.name,
      realName: data.user.real_name,
    };
  }
}

/**
 * Load Slack configuration from environment variables
 */
export function loadSlackConfig(): SlackConfig {
  const botToken = process.env.CALLME_SLACK_BOT_TOKEN;
  const appToken = process.env.CALLME_SLACK_APP_TOKEN;
  const userSlackId = process.env.CALLME_SLACK_USER_ID;

  if (!botToken) {
    throw new Error('Missing CALLME_SLACK_BOT_TOKEN (Bot User OAuth Token, starts with xoxb-)');
  }
  if (!appToken) {
    throw new Error('Missing CALLME_SLACK_APP_TOKEN (App-Level Token for Socket Mode, starts with xapp-)');
  }
  if (!userSlackId) {
    throw new Error('Missing CALLME_SLACK_USER_ID (Your Slack member ID, starts with U)');
  }

  return {
    botToken,
    appToken,
    userSlackId,
  };
}

/**
 * Validate Slack configuration
 */
export function validateSlackConfig(config: SlackConfig): string[] {
  const errors: string[] = [];

  if (!config.botToken || !config.botToken.startsWith('xoxb-')) {
    errors.push('CALLME_SLACK_BOT_TOKEN must start with xoxb-');
  }
  if (!config.appToken || !config.appToken.startsWith('xapp-')) {
    errors.push('CALLME_SLACK_APP_TOKEN must start with xapp-');
  }
  if (!config.userSlackId || !config.userSlackId.startsWith('U')) {
    errors.push('CALLME_SLACK_USER_ID must start with U');
  }

  return errors;
}
