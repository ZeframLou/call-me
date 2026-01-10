/**
 * Telegram Chat Manager
 *
 * Manages text-based conversations with users via Telegram Bot API.
 * This is an alternative to phone calls - simpler and free.
 */

import {
  TelegramProvider,
  TelegramBotProvider,
  TelegramUpdate,
} from './providers/telegram.js';

interface ChatState {
  chatId: string;
  conversationHistory: Array<{ speaker: 'claude' | 'user'; message: string }>;
  startTime: number;
  lastUpdateId: number;
  ended: boolean;
}

export interface TelegramConfig {
  botToken: string;
  userChatId: string;
  responseTimeoutMs: number;
  verboseMode: boolean;
  listenModeEnabled: boolean;
}

export function loadTelegramConfig(): TelegramConfig {
  const errors: string[] = [];

  if (!process.env.CALLME_TELEGRAM_BOT_TOKEN) {
    errors.push('Missing CALLME_TELEGRAM_BOT_TOKEN (from @BotFather)');
  }

  if (!process.env.CALLME_TELEGRAM_CHAT_ID) {
    errors.push('Missing CALLME_TELEGRAM_CHAT_ID (your Telegram user/chat ID)');
  }

  if (errors.length > 0) {
    throw new Error(`Missing required Telegram configuration:\n  - ${errors.join('\n  - ')}`);
  }

  // Default 5 minutes for response timeout
  const responseTimeoutMs = parseInt(process.env.CALLME_RESPONSE_TIMEOUT_MS || '300000', 10);

  // Verbose mode: stream all output to Telegram (default: false)
  const verboseMode = process.env.CALLME_TELEGRAM_VERBOSE === 'true' ||
                      process.env.CALLME_TELEGRAM_VERBOSE === '1';

  // Listen mode: enable listen_for_commands tool (default: false)
  const listenModeEnabled = process.env.CALLME_TELEGRAM_LISTEN === 'true' ||
                            process.env.CALLME_TELEGRAM_LISTEN === '1';

  return {
    botToken: process.env.CALLME_TELEGRAM_BOT_TOKEN!,
    userChatId: process.env.CALLME_TELEGRAM_CHAT_ID!,
    responseTimeoutMs,
    verboseMode,
    listenModeEnabled,
  };
}

export class TelegramChatManager {
  private activeChats = new Map<string, ChatState>();
  private config: TelegramConfig;
  private telegram: TelegramProvider;
  private currentChatId = 0;
  private globalUpdateOffset = 0;
  private verboseMode: boolean;
  private commandPollingActive = false;
  private shutdownRequested = false;
  private isListening = false;

  constructor(config: TelegramConfig) {
    this.config = config;
    this.verboseMode = config.verboseMode;
    this.telegram = new TelegramBotProvider();
    this.telegram.initialize({
      botToken: config.botToken,
      chatId: config.userChatId,
    });
  }

  async initialize(): Promise<void> {
    // Delete any existing webhook to use long polling
    await this.telegram.deleteWebhook();

    // Get current update offset to ignore old messages
    const updates = await this.telegram.getUpdates();
    if (updates.length > 0) {
      this.globalUpdateOffset = updates[updates.length - 1].update_id + 1;
    }

    // Start background command polling
    this.startCommandPolling();

    console.error('Telegram bot initialized, ready for messages');
  }

  /**
   * Background polling for commands when no chat is active.
   * This allows users to send /verbose, /help etc. anytime.
   */
  private async startCommandPolling(): Promise<void> {
    this.commandPollingActive = true;

    while (!this.shutdownRequested) {
      // Only poll when no active chats and not in listen mode
      if (this.activeChats.size === 0 && !this.isListening) {
        try {
          const updates = await this.telegram.getUpdates(this.globalUpdateOffset);

          for (const update of updates) {
            this.globalUpdateOffset = update.update_id + 1;

            if (
              update.message?.text &&
              String(update.message.chat.id) === this.config.userChatId
            ) {
              const text = update.message.text;
              const { isCommand, response } = this.handleCommand(text);

              if (isCommand && response) {
                await this.telegram.sendMessage(response);
                console.error(`[idle] Handled command: ${text}`);
              } else if (!isCommand) {
                // User sent a message but no active chat - inform them
                await this.telegram.sendMessage(
                  "I'm not currently in a conversation. Claude will message you when it needs input."
                );
              }
            }
          }
        } catch (error) {
          // Ignore polling errors during idle
          console.error('[idle] Polling error:', error);
        }
      }

      // Wait before next poll (shorter when idle to catch commands quickly)
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    this.commandPollingActive = false;
  }

  async initiateChat(message: string): Promise<{ chatId: string; response: string }> {
    const chatId = `chat-${++this.currentChatId}-${Date.now()}`;

    const state: ChatState = {
      chatId,
      conversationHistory: [],
      startTime: Date.now(),
      lastUpdateId: this.globalUpdateOffset,
      ended: false,
    };

    this.activeChats.set(chatId, state);

    try {
      // Send initial message
      await this.telegram.sendMessage(message);
      console.error(`[${chatId}] Sent: ${message.substring(0, 50)}...`);

      state.conversationHistory.push({ speaker: 'claude', message });

      // Wait for user response
      const response = await this.waitForResponse(state);
      state.conversationHistory.push({ speaker: 'user', message: response });

      return { chatId, response };
    } catch (error) {
      this.activeChats.delete(chatId);
      throw error;
    }
  }

  async continueChat(chatId: string, message: string): Promise<string> {
    const state = this.activeChats.get(chatId);
    if (!state) throw new Error(`No active chat: ${chatId}`);
    if (state.ended) throw new Error(`Chat ${chatId} has ended`);

    // Send message
    await this.telegram.sendMessage(message);
    console.error(`[${chatId}] Sent: ${message.substring(0, 50)}...`);

    state.conversationHistory.push({ speaker: 'claude', message });

    // Wait for response
    const response = await this.waitForResponse(state);
    state.conversationHistory.push({ speaker: 'user', message: response });

    return response;
  }

  async sendMessage(chatId: string, message: string): Promise<void> {
    const state = this.activeChats.get(chatId);
    if (!state) throw new Error(`No active chat: ${chatId}`);
    if (state.ended) throw new Error(`Chat ${chatId} has ended`);

    await this.telegram.sendMessage(message);
    console.error(`[${chatId}] Sent (no response expected): ${message.substring(0, 50)}...`);

    state.conversationHistory.push({ speaker: 'claude', message });
  }

  async endChat(chatId: string, message: string): Promise<{ durationSeconds: number }> {
    const state = this.activeChats.get(chatId);
    if (!state) throw new Error(`No active chat: ${chatId}`);

    // Send closing message
    await this.telegram.sendMessage(message);
    console.error(`[${chatId}] Sent closing message: ${message.substring(0, 50)}...`);

    state.conversationHistory.push({ speaker: 'claude', message });
    state.ended = true;

    const durationSeconds = Math.round((Date.now() - state.startTime) / 1000);

    // Update global offset
    this.globalUpdateOffset = state.lastUpdateId;

    this.activeChats.delete(chatId);

    return { durationSeconds };
  }

  private async waitForResponse(state: ChatState): Promise<string> {
    console.error(`[${state.chatId}] Waiting for user response...`);

    const startTime = Date.now();
    const timeout = this.config.responseTimeoutMs;

    while (Date.now() - startTime < timeout) {
      if (state.ended) {
        throw new Error('Chat was ended');
      }

      try {
        const updates = await this.telegram.getUpdates(state.lastUpdateId);

        for (const update of updates) {
          state.lastUpdateId = update.update_id + 1;
          this.globalUpdateOffset = state.lastUpdateId;

          // Check if this is a message from our target user
          if (
            update.message?.text &&
            String(update.message.chat.id) === this.config.userChatId
          ) {
            const text = update.message.text;

            // Check if it's a command
            const { isCommand, response: cmdResponse } = this.handleCommand(text);
            if (isCommand) {
              console.error(`[${state.chatId}] Handled command: ${text}`);
              if (cmdResponse) {
                await this.telegram.sendMessage(cmdResponse);
              }
              // Continue waiting for a real response
              continue;
            }

            console.error(`[${state.chatId}] User said: ${text}`);
            return text;
          }
        }
      } catch (error) {
        // Log but don't fail - could be temporary network issue
        console.error(`[${state.chatId}] Error getting updates:`, error);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    throw new Error(`Response timeout after ${timeout / 1000}s`);
  }

  getActiveChatCount(): number {
    return this.activeChats.size;
  }

  isVerboseMode(): boolean {
    return this.verboseMode;
  }

  isListenModeEnabled(): boolean {
    return this.config.listenModeEnabled;
  }

  setVerboseMode(enabled: boolean): void {
    this.verboseMode = enabled;
    console.error(`[config] Verbose mode ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Broadcast a message without managing chat state.
   * Used in verbose mode to stream output to user.
   */
  async broadcast(message: string): Promise<void> {
    await this.telegram.sendMessage(message);
    console.error(`[broadcast] ${message.substring(0, 50)}...`);
  }

  /**
   * Listen for a command from the user via Telegram.
   * Blocks until a non-command message is received.
   */
  async listenForCommand(prompt?: string): Promise<string> {
    this.isListening = true;

    try {
      // Send prompt if provided
      if (prompt) {
        await this.telegram.sendMessage(prompt);
      } else {
        await this.telegram.sendMessage('🎧 Listening for commands... Send me a task!');
      }

      console.error('[listen] Waiting for user command...');

      // Wait indefinitely for a message (use a very long timeout)
      const timeout = 24 * 60 * 60 * 1000; // 24 hours
      const startTime = Date.now();

      while (Date.now() - startTime < timeout) {
        try {
          const updates = await this.telegram.getUpdates(this.globalUpdateOffset);

          for (const update of updates) {
            this.globalUpdateOffset = update.update_id + 1;

            if (
              update.message?.text &&
              String(update.message.chat.id) === this.config.userChatId
            ) {
              const text = update.message.text;

              // Check if it's a slash command - handle it but keep listening
              const { isCommand, response } = this.handleCommand(text);
              if (isCommand) {
                console.error(`[listen] Handled command: ${text}`);
                if (response) {
                  await this.telegram.sendMessage(response);
                }
                continue;
              }

              // Got a real command from user
              console.error(`[listen] User command: ${text}`);
              return text;
            }
          }
        } catch (error) {
          console.error('[listen] Polling error:', error);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      throw new Error('Listen timeout - no command received in 24 hours');
    } finally {
      this.isListening = false;
    }
  }

  /**
   * Handle slash commands from user.
   * Returns true if the message was a command (and was handled).
   */
  private handleCommand(text: string): { isCommand: boolean; response?: string } {
    const trimmed = text.trim().toLowerCase();

    if (trimmed === '/verbose' || trimmed === '/verbose status') {
      return {
        isCommand: true,
        response: `Verbose mode is currently *${this.verboseMode ? 'ON' : 'OFF'}*\n\nCommands:\n/verbose on - Enable verbose mode\n/verbose off - Disable verbose mode`,
      };
    }

    if (trimmed === '/verbose on') {
      this.setVerboseMode(true);
      return {
        isCommand: true,
        response: '✓ Verbose mode *enabled*. Claude will now stream output to Telegram.',
      };
    }

    if (trimmed === '/verbose off') {
      this.setVerboseMode(false);
      return {
        isCommand: true,
        response: '✓ Verbose mode *disabled*. Claude will only message when input is needed.',
      };
    }

    if (trimmed === '/help') {
      return {
        isCommand: true,
        response: `*CallMe Telegram Bot*\n\nCommands:\n/verbose on - Enable output streaming\n/verbose off - Disable output streaming\n/verbose - Show current status\n/help - Show this message`,
      };
    }

    return { isCommand: false };
  }

  shutdown(): void {
    this.shutdownRequested = true;
    for (const chatId of this.activeChats.keys()) {
      this.endChat(chatId, 'Session ended. Goodbye!').catch(console.error);
    }
  }
}
