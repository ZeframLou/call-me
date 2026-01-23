/**
 * Tunnel provider abstraction for exposing local webhooks
 */

export interface TunnelProvider {
  readonly name: string;
  start(port: number): Promise<string>;
  getUrl(): string | null;
  isConnected(): boolean;
  stop(): Promise<void>;
}

export interface TunnelConfig {
  provider: 'ngrok' | 'cloudflare';
  ngrokAuthToken?: string;
  ngrokDomain?: string;
  cloudflareTunnelName?: string;
  cloudflareTunnelDomain?: string;
}

/** Shared constants for tunnel providers */
export const TUNNEL_CONSTANTS = {
  /** Maximum number of reconnection attempts before giving up */
  MAX_RECONNECT_ATTEMPTS: 10,
  /** Base delay in ms for exponential backoff (doubles each attempt) */
  BASE_RECONNECT_DELAY_MS: 2000,
  /** Interval in ms between health checks */
  HEALTH_CHECK_INTERVAL_MS: 30000,
  /** Timeout in ms for health check requests */
  HEALTH_CHECK_TIMEOUT_MS: 10000,
  /** Timeout in ms for tunnel establishment */
  TUNNEL_STARTUP_TIMEOUT_MS: 30000,
  /** Grace period in ms before SIGKILL after SIGTERM */
  SIGKILL_GRACE_PERIOD_MS: 2000,
} as const;
