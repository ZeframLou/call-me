/**
 * ngrok tunnel provider implementation
 */

import ngrok from '@ngrok/ngrok';
import { TUNNEL_CONSTANTS, type TunnelProvider } from './types.js';

export class NgrokTunnel implements TunnelProvider {
  readonly name = 'ngrok';

  private listener: ngrok.Listener | null = null;
  private currentPort: number | null = null;
  private currentUrl: string | null = null;
  private intentionallyClosed = false;
  private reconnectAttempts = 0;
  private checkInterval: ReturnType<typeof setInterval> | null = null;

  private readonly authToken: string;
  private readonly domain?: string;

  constructor(authToken: string, domain?: string) {
    this.authToken = authToken;
    this.domain = domain;
  }

  async start(port: number): Promise<string> {
    // Clean up any existing connection first
    if (this.listener || this.checkInterval) {
      await this.stop();
    }

    this.intentionallyClosed = false;
    this.reconnectAttempts = 0;
    this.currentPort = port;
    return this.doStart(port);
  }

  private async doStart(port: number): Promise<string> {
    this.listener = await ngrok.forward({
      addr: port,
      authtoken: this.authToken,
      domain: this.domain,
    });

    const url = this.listener.url();
    if (!url) {
      throw new Error('Failed to get ngrok URL');
    }

    this.currentUrl = url;
    this.reconnectAttempts = 0;
    console.error(`[ngrok] Tunnel established: ${url}`);

    this.monitorTunnel();

    return url;
  }

  private monitorTunnel(): void {
    this.checkInterval = setInterval(async () => {
      if (this.intentionallyClosed) {
        if (this.checkInterval) {
          clearInterval(this.checkInterval);
          this.checkInterval = null;
        }
        return;
      }

      if (!this.listener || !this.currentUrl) {
        if (this.checkInterval) {
          clearInterval(this.checkInterval);
          this.checkInterval = null;
        }
        console.error('[ngrok] Tunnel lost, attempting reconnect...');
        this.attemptReconnect();
        return;
      }

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TUNNEL_CONSTANTS.HEALTH_CHECK_TIMEOUT_MS);

        const response = await fetch(`${this.currentUrl}/health`, {
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!response.ok) {
          throw new Error(`Health check returned ${response.status}`);
        }
      } catch (error) {
        if (this.checkInterval) {
          clearInterval(this.checkInterval);
          this.checkInterval = null;
        }
        console.error('[ngrok] Tunnel health check failed:', error);
        this.attemptReconnect();
      }
    }, TUNNEL_CONSTANTS.HEALTH_CHECK_INTERVAL_MS);
  }

  private async attemptReconnect(): Promise<void> {
    if (this.intentionallyClosed || this.currentPort === null) {
      return;
    }

    if (this.reconnectAttempts >= TUNNEL_CONSTANTS.MAX_RECONNECT_ATTEMPTS) {
      console.error(`[ngrok] Max reconnect attempts (${TUNNEL_CONSTANTS.MAX_RECONNECT_ATTEMPTS}) reached, giving up`);
      return;
    }

    this.reconnectAttempts++;
    const delay = TUNNEL_CONSTANTS.BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1);
    console.error(`[ngrok] Reconnect attempt ${this.reconnectAttempts}/${TUNNEL_CONSTANTS.MAX_RECONNECT_ATTEMPTS} in ${delay}ms...`);

    await new Promise(resolve => setTimeout(resolve, delay));

    if (this.intentionallyClosed) {
      console.error('[ngrok] Reconnect cancelled - tunnel intentionally closed');
      return;
    }

    try {
      if (this.listener) {
        try {
          await this.listener.close();
        } catch {
          // Ignore close errors
        }
        this.listener = null;
      }

      const oldUrl = this.currentUrl;
      const newUrl = await this.doStart(this.currentPort);
      console.error(`[ngrok] Reconnected successfully: ${newUrl}`);

      if (oldUrl && newUrl !== oldUrl) {
        console.error(`[ngrok] WARNING: Tunnel URL changed from ${oldUrl} to ${newUrl}`);
        console.error('[ngrok] Phone provider webhooks may need to be updated');
      }
    } catch (error) {
      console.error('[ngrok] Reconnect failed:', error);
      this.attemptReconnect();
    }
  }

  getUrl(): string | null {
    return this.currentUrl;
  }

  isConnected(): boolean {
    return this.listener !== null && !this.intentionallyClosed;
  }

  async stop(): Promise<void> {
    this.intentionallyClosed = true;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.listener) {
      await this.listener.close();
      this.listener = null;
    }
    this.currentUrl = null;
  }
}
