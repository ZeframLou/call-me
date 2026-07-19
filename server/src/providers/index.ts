/**
 * Provider Factory
 *
 * Creates and configures providers based on environment variables.
 * Supports Telnyx or Twilio for phone, OpenAI for TTS and Realtime STT.
 */

import type { PhoneProvider, TTSProvider, RealtimeSTTProvider, ProviderRegistry, STTConfig } from './types.js';
import { TelnyxPhoneProvider } from './phone-telnyx.js';
import { TwilioPhoneProvider } from './phone-twilio.js';
import { OpenAITTSProvider } from './tts-openai.js';
import { KokoroTTSProvider } from './tts-kokoro.js';
import { OpenAIRealtimeSTTProvider } from './stt-openai-realtime.js';
import { TelnyxSTTProvider } from './stt-telnyx.js';
import { TelnyxTTSProvider } from './tts-telnyx.js';

export * from './types.js';

export type PhoneProviderType = 'telnyx' | 'twilio';
export type STTProviderType = 'openai-realtime' | 'telnyx';
export type TTSProviderType = 'openai' | 'kokoro' | 'telnyx';

export interface ProviderConfig {
  // Phone provider selection
  phoneProvider: PhoneProviderType;

  // STT provider selection
  sttProvider: STTProviderType;

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

  // Telnyx STT/TTS (uses the same API key as the Telnyx phone provider)
  telnyxApiKey?: string;
  telnyxSttEngine?: string;   // 'Telnyx' | 'Deepgram' | 'Google' | 'Azure'
  telnyxSttInputFormat?: string; // 'mulaw' | 'linear16' | 'alaw'
  telnyxSttLanguage?: string;
  telnyxTtsVoice?: string;
}

export function loadProviderConfig(): ProviderConfig {
  const sttSilenceDurationMs = process.env.CALLME_STT_SILENCE_DURATION_MS
    ? parseInt(process.env.CALLME_STT_SILENCE_DURATION_MS, 10)
    : undefined;

  // Default to telnyx if not specified
  const phoneProvider = (process.env.CALLME_PHONE_PROVIDER || 'telnyx') as PhoneProviderType;
  const sttProvider = (process.env.CALLME_STT_PROVIDER || (process.env.CALLME_PHONE_PROVIDER === 'telnyx' ? 'telnyx' : 'openai-realtime')) as STTProviderType;
  const ttsProvider = (process.env.CALLME_TTS_PROVIDER || 'openai') as TTSProviderType;

  return {
    phoneProvider,
    sttProvider,
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
    telnyxApiKey: process.env.CALLME_TELNYX_API_KEY || process.env.CALLME_PHONE_AUTH_TOKEN,
    telnyxSttEngine: process.env.CALLME_TELNYX_STT_ENGINE,
    telnyxSttInputFormat: process.env.CALLME_TELNYX_STT_INPUT_FORMAT,
    telnyxSttLanguage: process.env.CALLME_TELNYX_STT_LANGUAGE,
    telnyxTtsVoice: process.env.CALLME_TELNYX_TTS_VOICE,
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
  if (config.ttsProvider === 'telnyx') {
    const provider = new TelnyxTTSProvider();
    provider.initialize({
      apiKey: config.telnyxApiKey || config.phoneAuthToken,
      voice: config.telnyxTtsVoice,
    });
    return provider;
  }

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
  if (config.sttProvider === 'telnyx') {
    const provider = new TelnyxSTTProvider();
    provider.initialize({
      apiKey: config.telnyxApiKey || config.phoneAuthToken,
      model: config.telnyxSttLanguage,
      silenceDurationMs: config.sttSilenceDurationMs,
      transcriptionEngine: config.telnyxSttEngine,
      inputFormat: config.telnyxSttInputFormat,
    } as STTConfig);
    return provider;
  }

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
  // OpenAI key is required whenever any non-Telnyx STT or TTS provider is
  // selected. The previous logic only errored when BOTH were non-Telnyx,
  // which let mixed configs (e.g. openai-realtime STT + telnyx TTS) start
  // up clean and then fail at runtime.
  const needsOpenAI = config.sttProvider === 'openai-realtime' || config.ttsProvider === 'openai';
  if (!config.openaiApiKey && needsOpenAI) {
    errors.push('Missing CALLME_OPENAI_API_KEY (required when using OpenAI for STT or TTS)');
  }

  return errors;
}
