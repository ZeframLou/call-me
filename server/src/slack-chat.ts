/**
 * Slack Chat Manager
 *
 * Manages conversations with users via Slack direct messages.
 * Uses Socket Mode for real-time message reception (no webhooks/ngrok needed).
 *
 * Architecture:
 * - Outbound messages: Use Slack Web API (chat.postMessage)
 * - Inbound messages: Use Socket Mode WebSocket connection for real-time events
 */

import WebSocket from 'ws';
import { SlackProvider, loadSlackConfig, validateSlackConfig, type SlackConfig } from './providers/slack.js';

interface ChatState {
  chatId: string;
  channelId: string;
  lastMessageTs: string;
  conversationHistory: Array<{ speaker: 'claude' | 'user'; message: string }>;
  startTime: number;
  ended: boolean;
  pendingResponse: {
    resolve: (message: string) => void;
    reject: (error: Error) => void;
  } | null;
}

export interface SlackServerConfig {
  provider: SlackProvider;
  config: SlackConfig;
  responseTimeoutMs: number;
}

/**
 * Load configuration for Slack chat server
 */
export function loadSlackServerConfig(): SlackServerConfig {
  const config = loadSlackConfig();
  const errors = validateSlackConfig(config);

  if (errors.length > 0) {
    throw new Error(`Slack configuration errors:\n  - ${errors.join('\n  - ')}`);
  }

  const provider = new SlackProvider();
  provider.initialize(config);

  // Default 5 minutes for response timeout
  const responseTimeoutMs = parseInt(process.env.CALLME_SLACK_RESPONSE_TIMEOUT_MS || '300000', 10);

  return {
    provider,
    config,
    responseTimeoutMs,
  };
}

export class SlackChatManager {
  private activeChats = new Map<string, ChatState>();
  private config: SlackServerConfig;
  private currentChatId = 0;
  private socketModeWs: WebSocket | null = null;
  private socketModeConnected = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;

  constructor(config: SlackServerConfig) {
    this.config = config;
  }

  /**
   * Start the Socket Mode connection for receiving messages
   */
  async start(): Promise<void> {
    await this.connectSocketMode();
  }

  /**
   * Connect to Slack Socket Mode
   * Socket Mode uses a WebSocket connection to receive events without public webhooks
   */
  private async connectSocketMode(): Promise<void> {
    const appToken = this.config.provider.getAppToken();

    // Get WebSocket URL from Slack
    const response = await fetch('https://slack.com/api/apps.connections.open', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${appToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const data = await response.json() as {
      ok: boolean;
      url?: string;
      error?: string;
    };

    if (!data.ok || !data.url) {
      throw new Error(`Failed to get Socket Mode URL: ${data.error || 'Unknown error'}`);
    }

    console.error(`[Slack] Connecting to Socket Mode...`);

    this.socketModeWs = new WebSocket(data.url);

    this.socketModeWs.on('open', () => {
      console.error('[Slack] Socket Mode connected');
      this.socketModeConnected = true;
      this.reconnectAttempts = 0;
    });

    this.socketModeWs.on('message', (rawData: Buffer | string) => {
      try {
        const message = JSON.parse(rawData.toString());
        this.handleSocketModeMessage(message);
      } catch (error) {
        console.error('[Slack] Error parsing Socket Mode message:', error);
      }
    });

    this.socketModeWs.on('close', () => {
      console.error('[Slack] Socket Mode disconnected');
      this.socketModeConnected = false;
      this.attemptReconnect();
    });

    this.socketModeWs.on('error', (error) => {
      console.error('[Slack] Socket Mode error:', error);
    });

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Socket Mode connection timeout'));
      }, 10000);

      const checkConnection = setInterval(() => {
        if (this.socketModeConnected) {
          clearTimeout(timeout);
          clearInterval(checkConnection);
          resolve();
        }
      }, 100);
    });
  }

  /**
   * Handle incoming Socket Mode messages
   */
  private handleSocketModeMessage(message: any): void {
    // Acknowledge envelope messages
    if (message.envelope_id) {
      this.acknowledgeEnvelope(message.envelope_id);
    }

    // Handle different event types
    if (message.type === 'events_api') {
      const event = message.payload?.event;
      if (event?.type === 'message' && event.channel_type === 'im') {
        // Only process messages from users (not from bots)
        if (event.user && !event.bot_id && !event.subtype) {
          this.handleIncomingMessage(event);
        }
      }
    }

    // Handle hello message (connection established)
    if (message.type === 'hello') {
      console.error('[Slack] Socket Mode hello received');
    }

    // Handle disconnect request
    if (message.type === 'disconnect') {
      console.error('[Slack] Received disconnect request:', message.reason);
      this.attemptReconnect();
    }
  }

  /**
   * Acknowledge Socket Mode envelope to prevent retries
   */
  private acknowledgeEnvelope(envelopeId: string): void {
    if (this.socketModeWs?.readyState === WebSocket.OPEN) {
      this.socketModeWs.send(JSON.stringify({
        envelope_id: envelopeId,
      }));
    }
  }

  /**
   * Handle incoming user message
   */
  private handleIncomingMessage(event: {
    user: string;
    text: string;
    channel: string;
    ts: string;
  }): void {
    // Find the active chat for this channel
    for (const [chatId, state] of this.activeChats) {
      if (state.channelId === event.channel && !state.ended) {
        // Check if this message is from the expected user
        const expectedUserId = this.config.provider.getUserSlackId();
        if (event.user === expectedUserId) {
          state.lastMessageTs = event.ts;

          // If we're waiting for a response, resolve it
          if (state.pendingResponse) {
            state.pendingResponse.resolve(event.text);
            state.pendingResponse = null;
          }
        }
        break;
      }
    }
  }

  /**
   * Attempt to reconnect Socket Mode after disconnect
   */
  private async attemptReconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[Slack] Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

    console.error(`[Slack] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);
    await new Promise((resolve) => setTimeout(resolve, delay));

    try {
      await this.connectSocketMode();
    } catch (error) {
      console.error('[Slack] Reconnect failed:', error);
      this.attemptReconnect();
    }
  }

  /**
   * Start a new chat conversation
   */
  async sendMessage(message: string): Promise<{ chatId: string; response: string }> {
    const chatId = `slack-chat-${++this.currentChatId}-${Date.now()}`;

    // Open DM channel
    const channelId = await this.config.provider.openDMChannel();

    // Send the initial message
    const messageTs = await this.config.provider.sendMessage(message, channelId);

    const state: ChatState = {
      chatId,
      channelId,
      lastMessageTs: messageTs,
      conversationHistory: [{ speaker: 'claude', message }],
      startTime: Date.now(),
      ended: false,
      pendingResponse: null,
    };

    this.activeChats.set(chatId, state);

    console.error(`[Slack] Chat started: ${chatId}`);

    // Wait for user response
    const response = await this.waitForResponse(state);
    state.conversationHistory.push({ speaker: 'user', message: response });

    return { chatId, response };
  }

  /**
   * Continue an existing chat with a follow-up message
   */
  async continueChat(chatId: string, message: string): Promise<string> {
    const state = this.activeChats.get(chatId);
    if (!state) {
      throw new Error(`No active chat: ${chatId}`);
    }

    if (state.ended) {
      throw new Error(`Chat has ended: ${chatId}`);
    }

    // Send the message
    const messageTs = await this.config.provider.sendMessage(message, state.channelId);
    state.lastMessageTs = messageTs;
    state.conversationHistory.push({ speaker: 'claude', message });

    // Wait for user response
    const response = await this.waitForResponse(state);
    state.conversationHistory.push({ speaker: 'user', message: response });

    return response;
  }

  /**
   * Send a one-way notification (no response expected)
   */
  async notifyUser(chatId: string, message: string): Promise<void> {
    const state = this.activeChats.get(chatId);
    if (!state) {
      throw new Error(`No active chat: ${chatId}`);
    }

    if (state.ended) {
      throw new Error(`Chat has ended: ${chatId}`);
    }

    await this.config.provider.sendMessage(message, state.channelId);
    state.conversationHistory.push({ speaker: 'claude', message });
  }

  /**
   * End a chat conversation
   */
  async endChat(chatId: string, message: string): Promise<{ durationSeconds: number }> {
    const state = this.activeChats.get(chatId);
    if (!state) {
      throw new Error(`No active chat: ${chatId}`);
    }

    // Send closing message
    await this.config.provider.sendMessage(message, state.channelId);
    state.conversationHistory.push({ speaker: 'claude', message });

    // Mark as ended
    state.ended = true;

    // Cancel any pending response
    if (state.pendingResponse) {
      state.pendingResponse.reject(new Error('Chat ended'));
      state.pendingResponse = null;
    }

    const durationSeconds = Math.round((Date.now() - state.startTime) / 1000);
    this.activeChats.delete(chatId);

    console.error(`[Slack] Chat ended: ${chatId}, duration: ${durationSeconds}s`);

    return { durationSeconds };
  }

  /**
   * Wait for user response with timeout
   * Uses Socket Mode for real-time updates, with polling fallback
   */
  private async waitForResponse(state: ChatState): Promise<string> {
    console.error(`[Slack] Waiting for response...`);

    return new Promise((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        state.pendingResponse = null;
        reject(new Error('Response timeout'));
      }, this.config.responseTimeoutMs);

      // Store pending response for Socket Mode handler
      state.pendingResponse = {
        resolve: (message: string) => {
          clearTimeout(timeout);
          console.error(`[Slack] User responded: ${message.substring(0, 50)}...`);
          resolve(message);
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        },
      };

      // Also poll as fallback in case Socket Mode misses events
      this.pollForResponse(state, timeout, resolve);
    });
  }

  /**
   * Poll for responses as fallback to Socket Mode
   */
  private async pollForResponse(
    state: ChatState,
    timeout: NodeJS.Timeout,
    resolve: (message: string) => void
  ): Promise<void> {
    const pollInterval = 2000; // Poll every 2 seconds as fallback

    const poll = async () => {
      if (state.ended || !state.pendingResponse) {
        return;
      }

      try {
        const messages = await this.config.provider.getMessagesSince(
          state.channelId,
          state.lastMessageTs
        );

        // Find messages from the expected user
        const expectedUserId = this.config.provider.getUserSlackId();
        const userMessages = messages.filter((m) => m.user === expectedUserId);

        if (userMessages.length > 0) {
          const latestMessage = userMessages[userMessages.length - 1];
          state.lastMessageTs = latestMessage.ts;

          if (state.pendingResponse) {
            clearTimeout(timeout);
            state.pendingResponse = null;
            resolve(latestMessage.text);
            return;
          }
        }
      } catch (error) {
        console.error('[Slack] Polling error:', error);
      }

      // Schedule next poll
      if (!state.ended && state.pendingResponse) {
        setTimeout(poll, pollInterval);
      }
    };

    // Start polling after a short delay (give Socket Mode priority)
    setTimeout(poll, 1000);
  }

  /**
   * Check if Socket Mode is connected
   */
  isConnected(): boolean {
    return this.socketModeConnected;
  }

  /**
   * Shutdown the manager
   */
  shutdown(): void {
    // Close all active chats
    for (const [chatId, state] of this.activeChats) {
      if (state.pendingResponse) {
        state.pendingResponse.reject(new Error('Shutting down'));
      }
      state.ended = true;
    }
    this.activeChats.clear();

    // Close Socket Mode connection
    if (this.socketModeWs) {
      this.socketModeWs.close();
      this.socketModeWs = null;
    }

    this.socketModeConnected = false;
    console.error('[Slack] Chat manager shutdown');
  }
}
