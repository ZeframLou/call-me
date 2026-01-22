/**
 * Cloudflare Tunnel provider implementation
 */

import { spawn, type ChildProcess } from 'child_process';
import { TUNNEL_CONSTANTS, type TunnelProvider } from './types.js';

export class CloudflareTunnel implements TunnelProvider {
  readonly name = 'cloudflare';

  private process: ChildProcess | null = null;
  private currentPort: number | null = null;
  private currentUrl: string | null = null;
  private intentionallyClosed = false;
  private reconnectAttempts = 0;

  private readonly tunnelName?: string;
  private readonly tunnelDomain?: string;

  constructor(tunnelName?: string, tunnelDomain?: string) {
    this.tunnelName = tunnelName;
    this.tunnelDomain = tunnelDomain;
  }

  async start(port: number): Promise<string> {
    // Clean up any existing connection first
    if (this.process) {
      await this.stop();
    }

    this.intentionallyClosed = false;
    this.reconnectAttempts = 0;
    this.currentPort = port;
    return this.doStart(port);
  }

  private async doStart(port: number): Promise<string> {
    // Check if cloudflared is installed
    await this.checkCloudflaredInstalled();

    return new Promise((resolve, reject) => {
      let args: string[];

      if (this.tunnelName) {
        // Named tunnel mode (requires pre-configured tunnel)
        args = ['tunnel', 'run', this.tunnelName];
        // For named tunnels, we know the domain upfront
        if (this.tunnelDomain) {
          this.currentUrl = `https://${this.tunnelDomain}`;
        }
      } else {
        // Quick tunnel mode (no auth required)
        args = ['tunnel', '--url', `http://localhost:${port}`];
      }

      this.process = spawn('cloudflared', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let urlResolved = false;
      let stderrBuffer = '';
      let startupTimeout: ReturnType<typeof setTimeout> | null = null;
      const MAX_BUFFER_SIZE = 10000; // Limit buffer to prevent memory growth

      const handleOutput = (data: Buffer) => {
        const output = data.toString();
        stderrBuffer += output;
        // Keep only the last MAX_BUFFER_SIZE characters to prevent unbounded growth
        if (stderrBuffer.length > MAX_BUFFER_SIZE) {
          stderrBuffer = stderrBuffer.slice(-MAX_BUFFER_SIZE);
        }

        // For quick tunnels, parse URL from output
        // cloudflared outputs something like: "https://xxx-xxx-xxx.trycloudflare.com"
        if (!urlResolved && !this.tunnelName) {
          const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
          if (urlMatch) {
            this.currentUrl = urlMatch[0];
            urlResolved = true;
            this.reconnectAttempts = 0;
            if (startupTimeout) clearTimeout(startupTimeout);
            console.error(`[cloudflare] Tunnel established: ${this.currentUrl}`);
            resolve(this.currentUrl);
          }
        }

        // For named tunnels, look for connection established message
        if (!urlResolved && this.tunnelName && this.tunnelDomain) {
          if (output.includes('Registered tunnel connection') || output.includes('Connection registered')) {
            urlResolved = true;
            this.reconnectAttempts = 0;
            if (startupTimeout) clearTimeout(startupTimeout);
            console.error(`[cloudflare] Named tunnel established: ${this.currentUrl}`);
            resolve(this.currentUrl!);
          }
        }
      };

      this.process.stdout?.on('data', handleOutput);
      this.process.stderr?.on('data', handleOutput);

      this.process.on('error', (error) => {
        if (!urlResolved) {
          reject(new Error(`Failed to start cloudflared: ${error.message}`));
        }
      });

      this.process.on('exit', (code, signal) => {
        if (!urlResolved) {
          reject(new Error(
            `cloudflared exited unexpectedly (code=${code}, signal=${signal})\n` +
            `Output: ${stderrBuffer.slice(-500)}`
          ));
        } else if (!this.intentionallyClosed) {
          console.error(`[cloudflare] Tunnel process exited (code=${code}, signal=${signal})`);
          this.process = null;
          this.currentUrl = null;
          this.attemptReconnect();
        }
      });

      // Timeout for URL detection
      startupTimeout = setTimeout(() => {
        if (!urlResolved) {
          this.killProcess();
          reject(new Error(
            'Timed out waiting for cloudflared to establish tunnel.\n' +
            `Output: ${stderrBuffer.slice(-500)}`
          ));
        }
      }, TUNNEL_CONSTANTS.TUNNEL_STARTUP_TIMEOUT_MS);
    });
  }

  private async checkCloudflaredInstalled(): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = spawn('cloudflared', ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      check.on('error', () => {
        reject(new Error(
          'cloudflared CLI is not installed or not in PATH.\n\n' +
          'Install cloudflared:\n' +
          '  macOS:   brew install cloudflared\n' +
          '  Linux:   See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n' +
          '  Windows: winget install Cloudflare.cloudflared\n'
        ));
      });

      check.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error('cloudflared CLI check failed'));
        }
      });
    });
  }

  private async attemptReconnect(): Promise<void> {
    if (this.intentionallyClosed || this.currentPort === null) {
      return;
    }

    if (this.reconnectAttempts >= TUNNEL_CONSTANTS.MAX_RECONNECT_ATTEMPTS) {
      console.error(`[cloudflare] Max reconnect attempts (${TUNNEL_CONSTANTS.MAX_RECONNECT_ATTEMPTS}) reached, giving up`);
      return;
    }

    this.reconnectAttempts++;
    const delay = TUNNEL_CONSTANTS.BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1);
    console.error(`[cloudflare] Reconnect attempt ${this.reconnectAttempts}/${TUNNEL_CONSTANTS.MAX_RECONNECT_ATTEMPTS} in ${delay}ms...`);

    await new Promise(resolve => setTimeout(resolve, delay));

    if (this.intentionallyClosed) {
      console.error('[cloudflare] Reconnect cancelled - tunnel intentionally closed');
      return;
    }

    try {
      this.killProcess();
      const oldUrl = this.currentUrl;
      const newUrl = await this.doStart(this.currentPort);
      console.error(`[cloudflare] Reconnected successfully: ${newUrl}`);

      if (oldUrl && newUrl !== oldUrl) {
        console.error(`[cloudflare] WARNING: Tunnel URL changed from ${oldUrl} to ${newUrl}`);
        console.error('[cloudflare] Phone provider webhooks may need to be updated');
      }
    } catch (error) {
      console.error('[cloudflare] Reconnect failed:', error);
      this.attemptReconnect();
    }
  }

  private killProcess(): void {
    if (this.process) {
      const proc = this.process;
      this.process = null;
      try {
        proc.kill('SIGTERM');
        // Give it a moment to clean up, then force kill
        setTimeout(() => {
          try {
            if (!proc.killed) {
              proc.kill('SIGKILL');
            }
          } catch {
            // Process may have already exited
          }
        }, TUNNEL_CONSTANTS.SIGKILL_GRACE_PERIOD_MS);
      } catch {
        // Ignore kill errors
      }
    }
  }

  getUrl(): string | null {
    return this.currentUrl;
  }

  isConnected(): boolean {
    return this.process !== null && !this.intentionallyClosed;
  }

  async stop(): Promise<void> {
    this.intentionallyClosed = true;
    this.killProcess();
    this.currentUrl = null;
  }
}
