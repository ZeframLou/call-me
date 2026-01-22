/**
 * Tunnel provider factory and configuration
 */

import type { TunnelConfig, TunnelProvider } from './types.js';
import { NgrokTunnel } from './ngrok.js';
import { CloudflareTunnel } from './cloudflare.js';

export type { TunnelConfig, TunnelProvider } from './types.js';

/**
 * Load tunnel configuration from environment variables
 */
export function loadTunnelConfig(): TunnelConfig {
  const provider = (process.env.CALLME_TUNNEL_PROVIDER || 'ngrok') as 'ngrok' | 'cloudflare';

  return {
    provider,
    ngrokAuthToken: process.env.CALLME_NGROK_AUTHTOKEN,
    ngrokDomain: process.env.CALLME_NGROK_DOMAIN,
    cloudflareTunnelName: process.env.CALLME_CLOUDFLARE_TUNNEL_NAME,
    cloudflareTunnelDomain: process.env.CALLME_CLOUDFLARE_TUNNEL_DOMAIN,
  };
}

/** Valid pattern for tunnel names (alphanumeric, hyphens, underscores) */
const VALID_TUNNEL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate tunnel configuration and return any errors
 */
export function validateTunnelConfig(config: TunnelConfig): string[] {
  const errors: string[] = [];

  if (config.provider !== 'ngrok' && config.provider !== 'cloudflare') {
    errors.push(`Invalid tunnel provider: ${config.provider}. Must be 'ngrok' or 'cloudflare'.`);
    return errors;
  }

  if (config.provider === 'ngrok') {
    if (!config.ngrokAuthToken) {
      errors.push(
        'CALLME_NGROK_AUTHTOKEN is required for ngrok.\n' +
        'Get a free auth token at https://dashboard.ngrok.com/get-started/your-authtoken'
      );
    }
  }

  if (config.provider === 'cloudflare') {
    // Validate tunnel name format to prevent command injection
    if (config.cloudflareTunnelName && !VALID_TUNNEL_NAME_PATTERN.test(config.cloudflareTunnelName)) {
      errors.push(
        'CALLME_CLOUDFLARE_TUNNEL_NAME contains invalid characters.\n' +
        'Only alphanumeric characters, hyphens, and underscores are allowed.'
      );
    }

    // Named tunnel requires both name and domain
    if (config.cloudflareTunnelName && !config.cloudflareTunnelDomain) {
      errors.push(
        'CALLME_CLOUDFLARE_TUNNEL_DOMAIN is required when using a named tunnel.\n' +
        'Set it to the domain configured for your tunnel.'
      );
    }
  }

  return errors;
}

/**
 * Create a tunnel provider based on configuration
 * @throws Error if configuration is invalid (call validateTunnelConfig first)
 */
export function createTunnelProvider(config: TunnelConfig): TunnelProvider {
  switch (config.provider) {
    case 'ngrok':
      if (!config.ngrokAuthToken) {
        throw new Error('ngrokAuthToken is required for ngrok provider');
      }
      return new NgrokTunnel(config.ngrokAuthToken, config.ngrokDomain);

    case 'cloudflare':
      return new CloudflareTunnel(config.cloudflareTunnelName, config.cloudflareTunnelDomain);

    default:
      throw new Error(`Unknown tunnel provider: ${config.provider}`);
  }
}
