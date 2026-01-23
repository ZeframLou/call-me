/**
 * Tests for webhook security functions
 */

import { describe, test, expect } from 'bun:test';
import { createHmac } from 'crypto';
import {
  validateTwilioSignature,
  validateTelnyxSignature,
  generateWebSocketToken,
  validateWebSocketToken,
} from './webhook-security.js';

describe('validateTwilioSignature', () => {
  const authToken = 'test-auth-token-12345';

  test('returns false when signature is missing', () => {
    const params = new URLSearchParams({ CallSid: 'CA123', CallStatus: 'ringing' });
    const result = validateTwilioSignature(authToken, undefined, 'https://example.com/twiml', params);
    expect(result).toBe(false);
  });

  test('validates correct signature', () => {
    const url = 'https://example.com/twiml';
    const params = new URLSearchParams({ CallSid: 'CA123', CallStatus: 'ringing' });

    // Build expected signature the same way Twilio does
    let dataToSign = url;
    const sortedParams = Array.from(params.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    for (const [key, value] of sortedParams) {
      dataToSign += key + value;
    }
    const expectedSignature = createHmac('sha1', authToken)
      .update(dataToSign)
      .digest('base64');

    const result = validateTwilioSignature(authToken, expectedSignature, url, params);
    expect(result).toBe(true);
  });

  test('rejects incorrect signature', () => {
    const params = new URLSearchParams({ CallSid: 'CA123' });
    const result = validateTwilioSignature(authToken, 'invalid-signature', 'https://example.com/twiml', params);
    expect(result).toBe(false);
  });

  test('handles empty params', () => {
    const url = 'https://example.com/twiml';
    const params = new URLSearchParams();

    const expectedSignature = createHmac('sha1', authToken)
      .update(url)
      .digest('base64');

    const result = validateTwilioSignature(authToken, expectedSignature, url, params);
    expect(result).toBe(true);
  });

  test('sorts params alphabetically', () => {
    const url = 'https://example.com/twiml';
    // Add params in non-alphabetical order
    const params = new URLSearchParams();
    params.set('Zebra', 'z');
    params.set('Apple', 'a');
    params.set('Mango', 'm');

    // Build signature with sorted params
    let dataToSign = url + 'Applea' + 'Mangom' + 'Zebraz';
    const expectedSignature = createHmac('sha1', authToken)
      .update(dataToSign)
      .digest('base64');

    const result = validateTwilioSignature(authToken, expectedSignature, url, params);
    expect(result).toBe(true);
  });
});

describe('validateTelnyxSignature', () => {
  // Note: Telnyx uses Ed25519 which requires proper key pairs
  // We test the validation logic, not the actual crypto (that's tested by Node's crypto library)

  test('returns false when signature is missing', () => {
    const result = validateTelnyxSignature('public-key', undefined, '1234567890', '{}');
    expect(result).toBe(false);
  });

  test('returns false when timestamp is missing', () => {
    const result = validateTelnyxSignature('public-key', 'signature', undefined, '{}');
    expect(result).toBe(false);
  });

  test('returns false when timestamp is too old', () => {
    // Timestamp from 10 minutes ago
    const oldTimestamp = Math.floor((Date.now() - 10 * 60 * 1000) / 1000).toString();
    const result = validateTelnyxSignature('public-key', 'signature', oldTimestamp, '{}');
    expect(result).toBe(false);
  });

  test('returns false when timestamp is in future', () => {
    // Timestamp 10 minutes in the future
    const futureTimestamp = Math.floor((Date.now() + 10 * 60 * 1000) / 1000).toString();
    const result = validateTelnyxSignature('public-key', 'signature', futureTimestamp, '{}');
    expect(result).toBe(false);
  });

  test('returns false for invalid signature format', () => {
    const currentTimestamp = Math.floor(Date.now() / 1000).toString();
    // Invalid base64 will cause crypto error
    const result = validateTelnyxSignature('invalid-key', '!!!invalid!!!', currentTimestamp, '{}');
    expect(result).toBe(false);
  });
});

describe('generateWebSocketToken', () => {
  test('generates a token', () => {
    const token = generateWebSocketToken();
    expect(token).toBeDefined();
    expect(typeof token).toBe('string');
  });

  test('generates unique tokens', () => {
    const token1 = generateWebSocketToken();
    const token2 = generateWebSocketToken();
    expect(token1).not.toBe(token2);
  });

  test('generates tokens of expected length', () => {
    const token = generateWebSocketToken();
    // 32 bytes in base64url is approximately 43 characters
    expect(token.length).toBeGreaterThan(40);
    expect(token.length).toBeLessThan(50);
  });

  test('generates base64url-safe tokens', () => {
    const token = generateWebSocketToken();
    // base64url should not contain + or /
    expect(token).not.toContain('+');
    expect(token).not.toContain('/');
  });
});

describe('validateWebSocketToken', () => {
  test('returns true for matching tokens', () => {
    const token = generateWebSocketToken();
    const result = validateWebSocketToken(token, token);
    expect(result).toBe(true);
  });

  test('returns false for different tokens', () => {
    const token1 = generateWebSocketToken();
    const token2 = generateWebSocketToken();
    const result = validateWebSocketToken(token1, token2);
    expect(result).toBe(false);
  });

  test('returns false when received token is undefined', () => {
    const token = generateWebSocketToken();
    const result = validateWebSocketToken(token, undefined);
    expect(result).toBe(false);
  });

  test('returns false for different length tokens', () => {
    const result = validateWebSocketToken('short', 'much-longer-token');
    expect(result).toBe(false);
  });

  test('returns false for empty tokens', () => {
    const result = validateWebSocketToken('token', '');
    expect(result).toBe(false);
  });

  test('is timing-safe (same length comparison)', () => {
    // This tests that the function compares all characters even if early ones differ
    // We can't directly test timing, but we verify the algorithm works correctly
    const token = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const wrongToken = 'baaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const result = validateWebSocketToken(token, wrongToken);
    expect(result).toBe(false);
  });
});
