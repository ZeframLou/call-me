/**
 * Tests for tunnel configuration and factory
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { loadTunnelConfig, validateTunnelConfig, createTunnelProvider } from './index.js';
import { NgrokTunnel } from './ngrok.js';
import { CloudflareTunnel } from './cloudflare.js';

describe('loadTunnelConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('defaults to ngrok provider', () => {
    delete process.env.CALLME_TUNNEL_PROVIDER;
    const config = loadTunnelConfig();
    expect(config.provider).toBe('ngrok');
  });

  test('loads ngrok provider from env', () => {
    process.env.CALLME_TUNNEL_PROVIDER = 'ngrok';
    process.env.CALLME_NGROK_AUTHTOKEN = 'test-token';
    process.env.CALLME_NGROK_DOMAIN = 'test.ngrok.io';

    const config = loadTunnelConfig();

    expect(config.provider).toBe('ngrok');
    expect(config.ngrokAuthToken).toBe('test-token');
    expect(config.ngrokDomain).toBe('test.ngrok.io');
  });

  test('loads cloudflare provider from env', () => {
    process.env.CALLME_TUNNEL_PROVIDER = 'cloudflare';
    process.env.CALLME_CLOUDFLARE_TUNNEL_NAME = 'my-tunnel';
    process.env.CALLME_CLOUDFLARE_TUNNEL_DOMAIN = 'example.com';

    const config = loadTunnelConfig();

    expect(config.provider).toBe('cloudflare');
    expect(config.cloudflareTunnelName).toBe('my-tunnel');
    expect(config.cloudflareTunnelDomain).toBe('example.com');
  });
});

describe('validateTunnelConfig', () => {
  test('returns error for invalid provider', () => {
    const config = { provider: 'invalid' as any };
    const errors = validateTunnelConfig(config);

    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('Invalid tunnel provider');
  });

  test('returns error when ngrok auth token is missing', () => {
    const config = { provider: 'ngrok' as const };
    const errors = validateTunnelConfig(config);

    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('CALLME_NGROK_AUTHTOKEN');
  });

  test('passes validation for valid ngrok config', () => {
    const config = {
      provider: 'ngrok' as const,
      ngrokAuthToken: 'test-token',
    };
    const errors = validateTunnelConfig(config);

    expect(errors.length).toBe(0);
  });

  test('passes validation for cloudflare quick tunnel', () => {
    const config = { provider: 'cloudflare' as const };
    const errors = validateTunnelConfig(config);

    expect(errors.length).toBe(0);
  });

  test('returns error when cloudflare tunnel name has domain but no name', () => {
    const config = {
      provider: 'cloudflare' as const,
      cloudflareTunnelName: 'my-tunnel',
      // missing cloudflareTunnelDomain
    };
    const errors = validateTunnelConfig(config);

    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('CALLME_CLOUDFLARE_TUNNEL_DOMAIN');
  });

  test('passes validation for cloudflare named tunnel', () => {
    const config = {
      provider: 'cloudflare' as const,
      cloudflareTunnelName: 'my-tunnel',
      cloudflareTunnelDomain: 'example.com',
    };
    const errors = validateTunnelConfig(config);

    expect(errors.length).toBe(0);
  });

  test('rejects tunnel name with invalid characters', () => {
    const config = {
      provider: 'cloudflare' as const,
      cloudflareTunnelName: 'my-tunnel; rm -rf /',
      cloudflareTunnelDomain: 'example.com',
    };
    const errors = validateTunnelConfig(config);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('invalid characters');
  });

  test('allows valid tunnel name characters', () => {
    const config = {
      provider: 'cloudflare' as const,
      cloudflareTunnelName: 'my-tunnel_123',
      cloudflareTunnelDomain: 'example.com',
    };
    const errors = validateTunnelConfig(config);

    expect(errors.length).toBe(0);
  });
});

describe('createTunnelProvider', () => {
  test('creates NgrokTunnel for ngrok provider', () => {
    const config = {
      provider: 'ngrok' as const,
      ngrokAuthToken: 'test-token',
      ngrokDomain: 'test.ngrok.io',
    };
    const provider = createTunnelProvider(config);

    expect(provider).toBeInstanceOf(NgrokTunnel);
    expect(provider.name).toBe('ngrok');
  });

  test('creates CloudflareTunnel for cloudflare provider', () => {
    const config = {
      provider: 'cloudflare' as const,
      cloudflareTunnelName: 'my-tunnel',
      cloudflareTunnelDomain: 'example.com',
    };
    const provider = createTunnelProvider(config);

    expect(provider).toBeInstanceOf(CloudflareTunnel);
    expect(provider.name).toBe('cloudflare');
  });

  test('throws error when ngrok auth token is missing', () => {
    const config = { provider: 'ngrok' as const };

    expect(() => createTunnelProvider(config)).toThrow('ngrokAuthToken is required');
  });

  test('throws error for unknown provider', () => {
    const config = { provider: 'unknown' as any };

    expect(() => createTunnelProvider(config)).toThrow('Unknown tunnel provider');
  });
});
