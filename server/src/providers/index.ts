/**
 * Provider Factory
 *
 * Creates and configures providers based on environment variables.
 * Supports Telnyx or Twilio for phone, OpenAI for TTS and Realtime STT.
 * Also exports Slack provider for text-based messaging.
 */

import type { PhoneProvider, TTSProvider, RealtimeSTTProvider, ProviderRegistry } from './types.js';
import { TelnyxPhoneProvider } from './phone-telnyx.js';
import { TwilioPhoneProvider } from './phone-twilio.js';
import { OpenAITTSProvider } from './tts-openai.js';
import { KokoroTTSProvider } from './tts-kokoro.js';
import { OpenAIRealtimeSTTProvider } from './stt-openai-realtime.js';

export * from './types.js';
export * from './slack.js';

export type PhoneProviderType = 'telnyx' | 'twilio';
export type TTSProviderType = 'openai' | 'kokoro';

export interface ProviderConfig {
  // Phone provider selection
  phoneProvider: PhoneProviderType;

  // TTS provider selection
  ttsProvider: TTSProviderType;

  // Phone credentials (interpretation depends on provider)
  // Telnyx: accountSid = Connection ID, authToken = API Key
  // Twilio: accountSid = Account SID, authToken = Auth Token
  phoneAccountSid: string;
  phoneAuthToken: string;
  phoneNumber: string;

  // Telnyx webhook public key (for signature verification)
  // Get from: Mission Control > Account Settings > Keys & Credentials > Public Key
  telnyxPublicKey?: string;

  // OpenAI (STT, and TTS when ttsProvider is 'openai')
  openaiApiKey: string;
  ttsVoice?: string;
  sttModel?: string;
  sttSilenceDurationMs?: number;

  // Kokoro TTS (when ttsProvider is 'kokoro')
  kokoroUrl?: string;
}

export function loadProviderConfig(): ProviderConfig {
  const sttSilenceDurationMs = process.env.CALLME_STT_SILENCE_DURATION_MS
    ? parseInt(process.env.CALLME_STT_SILENCE_DURATION_MS, 10)
    : undefined;

  // Default to telnyx if not specified
  const phoneProvider = (process.env.CALLME_PHONE_PROVIDER || 'telnyx') as PhoneProviderType;
  const ttsProvider = (process.env.CALLME_TTS_PROVIDER || 'openai') as TTSProviderType;

  return {
    phoneProvider,
    ttsProvider,
    phoneAccountSid: process.env.CALLME_PHONE_ACCOUNT_SID || '',
    phoneAuthToken: process.env.CALLME_PHONE_AUTH_TOKEN || '',
    phoneNumber: process.env.CALLME_PHONE_NUMBER || '',
    telnyxPublicKey: process.env.CALLME_TELNYX_PUBLIC_KEY,
    openaiApiKey: process.env.CALLME_OPENAI_API_KEY || '',
    ttsVoice: process.env.CALLME_TTS_VOICE || undefined,
    sttModel: process.env.CALLME_STT_MODEL || 'gpt-4o-transcribe',
    sttSilenceDurationMs,
    kokoroUrl: process.env.CALLME_KOKORO_URL,
  };
}

export function createPhoneProvider(config: ProviderConfig): PhoneProvider {
  let provider: PhoneProvider;

  if (config.phoneProvider === 'twilio') {
    provider = new TwilioPhoneProvider();
  } else {
    provider = new TelnyxPhoneProvider();
  }

  provider.initialize({
    accountSid: config.phoneAccountSid,
    authToken: config.phoneAuthToken,
    phoneNumber: config.phoneNumber,
  });

  return provider;
}

export function createTTSProvider(config: ProviderConfig): TTSProvider {
  if (config.ttsProvider === 'kokoro') {
    const provider = new KokoroTTSProvider();
    provider.initialize({
      apiUrl: config.kokoroUrl,
      voice: config.ttsVoice || 'af_bella',
    });
    return provider;
  }

  const provider = new OpenAITTSProvider();
  provider.initialize({
    apiKey: config.openaiApiKey,
    voice: config.ttsVoice,
  });
  return provider;
}

export function createSTTProvider(config: ProviderConfig): RealtimeSTTProvider {
  const provider = new OpenAIRealtimeSTTProvider();
  provider.initialize({
    apiKey: config.openaiApiKey,
    model: config.sttModel,
    silenceDurationMs: config.sttSilenceDurationMs,
  });
  return provider;
}

export function createProviders(config: ProviderConfig): ProviderRegistry {
  return {
    phone: createPhoneProvider(config),
    tts: createTTSProvider(config),
    stt: createSTTProvider(config),
  };
}

/**
 * Validate that required config is present
 */
export function validateProviderConfig(config: ProviderConfig): string[] {
  const errors: string[] = [];

  // Provider-specific credential descriptions
  const credentialDesc = config.phoneProvider === 'twilio'
    ? { accountSid: 'Twilio Account SID', authToken: 'Twilio Auth Token' }
    : { accountSid: 'Telnyx Connection ID', authToken: 'Telnyx API Key' };

  if (!config.phoneAccountSid) {
    errors.push(`Missing CALLME_PHONE_ACCOUNT_SID (${credentialDesc.accountSid})`);
  }
  if (!config.phoneAuthToken) {
    errors.push(`Missing CALLME_PHONE_AUTH_TOKEN (${credentialDesc.authToken})`);
  }
  if (!config.phoneNumber) {
    errors.push('Missing CALLME_PHONE_NUMBER');
  }
  if (!config.openaiApiKey) {
    errors.push('Missing CALLME_OPENAI_API_KEY (required for speech-to-text, even when using Kokoro TTS)');
  }

  return errors;
}
