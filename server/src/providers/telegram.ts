/**
 * Telegram Bot Provider
 *
 * Handles Telegram Bot API integration for text-based communication with users.
 */

export interface TelegramConfig {
  botToken: string;
  chatId: string; // User's chat ID
  maxRetries?: number; // Max retry attempts (default: 3)
  retryDelayMs?: number; // Initial retry delay in ms (default: 1000)
}

export interface TelegramProvider {
  readonly name: string;
  initialize(config: TelegramConfig): void;
  sendMessage(text: string): Promise<number>; // Returns message ID
  getUpdates(offset?: number): Promise<TelegramUpdate[]>;
  deleteWebhook(): Promise<void>;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: {
      id: number;
      first_name: string;
      username?: string;
    };
    chat: {
      id: number;
      type: string;
    };
    date: number;
    text?: string;
  };
}

export class TelegramBotProvider implements TelegramProvider {
  readonly name = 'telegram';
  private botToken: string = '';
  private chatId: string = '';
  private baseUrl: string = '';
  private maxRetries: number = 3;
  private retryDelayMs: number = 1000;

  initialize(config: TelegramConfig): void {
    this.botToken = config.botToken;
    this.chatId = config.chatId;
    this.baseUrl = `https://api.telegram.org/bot${this.botToken}`;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelayMs = config.retryDelayMs ?? 1000;
  }

  /**
   * Execute a fetch request with exponential backoff retry logic
   */
  private async fetchWithRetry<T>(
    url: string,
    options?: RequestInit,
    operation: string = 'API call'
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await fetch(url, options);

        if (!response.ok) {
          const errorText = await response.text();
          // Don't retry on client errors (4xx) except 429 (rate limit)
          if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            throw new Error(`Telegram API error (${response.status}): ${errorText}`);
          }
          throw new Error(`Telegram API error (${response.status}): ${errorText}`);
        }

        const result = await response.json() as { ok: boolean; result: T };
        if (!result.ok) {
          throw new Error(`Telegram API returned ok=false`);
        }
        return result.result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry on client errors (except rate limits which we handle above)
        if (lastError.message.includes('(4') && !lastError.message.includes('(429)')) {
          throw lastError;
        }

        if (attempt < this.maxRetries) {
          const delay = this.retryDelayMs * Math.pow(2, attempt);
          console.error(`[Telegram] ${operation} failed (attempt ${attempt + 1}/${this.maxRetries + 1}), retrying in ${delay}ms: ${lastError.message}`);
          await this.sleep(delay);
        }
      }
    }

    throw new Error(`${operation} failed after ${this.maxRetries + 1} attempts: ${lastError?.message}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async sendMessage(text: string): Promise<number> {
    const result = await this.fetchWithRetry<{ message_id: number }>(
      `${this.baseUrl}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'Markdown',
        }),
      },
      'sendMessage'
    );
    return result.message_id;
  }

  async getUpdates(offset?: number): Promise<TelegramUpdate[]> {
    const params = new URLSearchParams({
      timeout: '30',
      allowed_updates: JSON.stringify(['message']),
    });
    if (offset !== undefined) {
      params.set('offset', String(offset));
    }

    return this.fetchWithRetry<TelegramUpdate[]>(
      `${this.baseUrl}/getUpdates?${params}`,
      undefined,
      'getUpdates'
    );
  }

  async deleteWebhook(): Promise<void> {
    await this.fetchWithRetry<boolean>(
      `${this.baseUrl}/deleteWebhook`,
      { method: 'POST' },
      'deleteWebhook'
    );
  }
}

export function createTelegramProvider(): TelegramProvider {
  return new TelegramBotProvider();
}
