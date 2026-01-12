/**
 * Provider Interfaces
 *
 * Abstractions for Phone, STT, and TTS services.
 * All providers use realtime streaming where applicable.
 */

/**
 * Phone Provider - handles initiating calls and WebSocket media streams
 */
export interface PhoneProvider {
  readonly name: string;

  /**
   * Initialize the provider with credentials
   */
  initialize(config: PhoneConfig): void;

  /**
   * Initiate an outbound call
   * @returns Call control ID from the provider
   */
  initiateCall(to: string, from: string, webhookUrl: string): Promise<string>;

  /**
   * Hang up an active call
   */
  hangup(callControlId: string): Promise<void>;

  /**
   * Start media streaming for a call
   */
  startStreaming(callControlId: string, streamUrl: string): Promise<void>;

  /**
   * Get XML response for connecting media stream (used in webhooks)
   */
  getStreamConnectXml(streamUrl: string): string;

  /**
   * Send an SMS message (optional - for fallback when call not answered)
   */
  sendSMS?(to: string, from: string, message: string): Promise<void>;

  /**
   * Configure the phone number's SMS webhook URL (optional - for auto-config on startup)
   */
  configureSmsWebhook?(phoneNumber: string, webhookUrl: string): Promise<void>;
}

export interface PhoneConfig {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
}

/**
 * Realtime Speech-to-Text Provider
 * Provides streaming transcription with automatic turn detection
 */
export interface RealtimeSTTProvider {
  readonly name: string;

  /**
   * Initialize the provider
   */
  initialize(config: STTConfig): void;

  /**
   * Create a new realtime transcription session
   */
  createSession(): RealtimeSTTSession;
}

/**
 * Realtime STT Session - handles streaming audio and receiving transcripts
 */
export interface RealtimeSTTSession {
  /**
   * Connect to the transcription service
   */
  connect(): Promise<void>;

  /**
   * Send audio data to the transcription session
   * @param audio mu-law audio buffer (8kHz mono)
   */
  sendAudio(audio: Buffer): void;

  /**
   * Wait for the next complete transcript (after VAD detects end of speech)
   * @param timeoutMs Maximum time to wait
   */
  waitForTranscript(timeoutMs?: number): Promise<string>;

  /**
   * Set callback for partial transcriptions (streaming)
   */
  onPartial(callback: (partial: string) => void): void;

  /**
   * Close the session
   */
  close(): void;

  /**
   * Check if session is connected
   */
  isConnected(): boolean;
}

export interface STTConfig {
  apiKey?: string;
  apiUrl?: string;
  model?: string;
  silenceDurationMs?: number;
}

/**
 * Text-to-Speech Provider
 */
export interface TTSProvider {
  readonly name: string;

  /**
   * Initialize the provider
   */
  initialize(config: TTSConfig): void;

  /**
   * Convert text to speech
   * @returns PCM audio buffer (16-bit, mono, 24kHz)
   */
  synthesize(text: string): Promise<Buffer>;

  /**
   * Stream TTS audio as chunks arrive (optional, for lower latency)
   */
  synthesizeStream?(text: string): AsyncGenerator<Buffer>;
}

export interface TTSConfig {
  apiKey?: string;
  apiUrl?: string;
  voice?: string;
  model?: string;
}

/**
 * Provider registry for dependency injection
 */
export interface ProviderRegistry {
  phone: PhoneProvider;
  tts: TTSProvider;
  stt: RealtimeSTTProvider;
}
