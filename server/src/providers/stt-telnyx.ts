/**
 * Telnyx STT Provider
 *
 * Streaming speech-to-text via the Telnyx WebSocket API.
 * Endpoint: wss://api.telnyx.com/v2/speech-to-text/transcription
 *
 * Uses the same Telnyx API key as the phone provider, so no extra
 * account or credential is needed when CALLME_PHONE_PROVIDER=telnyx.
 *
 * Accepts mu-law audio directly (8kHz mono), which is the format the
 * phone bridge already produces, so no audio conversion is required.
 *
 * Protocol:
 *   - Connect with Authorization: Bearer <key> header.
 *   - Config via URL query params: transcription_engine, input_format,
 *     sample_rate, language, interim_results.
 *   - Send raw audio as binary WebSocket frames.
 *   - Receive JSON text frames: { transcript, confidence, is_final }.
 *   - Send { "type": "CloseStream" } to end the session.
 */

import WebSocket from 'ws';
import type { RealtimeSTTProvider, RealtimeSTTSession, STTConfig } from './types.js';

export class TelnyxSTTProvider implements RealtimeSTTProvider {
  readonly name = 'telnyx';
  private apiKey: string | null = null;
  private transcriptionEngine: string = 'Telnyx';
  private inputFormat: string = 'mulaw';
  private sampleRate: number = 8000;
  private language: string = 'en-US';
  private interimResults: boolean = true;
  private silenceDurationMs: number = 800;

  initialize(config: STTConfig): void {
    if (!config.apiKey) {
      throw new Error('Telnyx API key required for STT');
    }
    this.apiKey = config.apiKey;
    // Telnyx STT accepts mulaw, linear16, alaw. Default to mulaw so the
    // phone bridge audio can be sent directly without conversion.
    this.transcriptionEngine = (config as any).transcriptionEngine || 'Telnyx';
    this.inputFormat = (config as any).inputFormat || 'mulaw';
    this.sampleRate = (config as any).sampleRate || 8000;
    this.language = config.model || 'en-US';
    this.interimResults = (config as any).interimResults !== false;
    this.silenceDurationMs = config.silenceDurationMs || 800;
    console.error(
      `STT provider: Telnyx (${this.transcriptionEngine}, ${this.inputFormat}, ${this.sampleRate}Hz, silence: ${this.silenceDurationMs}ms)`
    );
  }

  createSession(): RealtimeSTTSession {
    if (!this.apiKey) throw new Error('Telnyx STT not initialized');
    return new TelnyxSTTSession(
      this.apiKey,
      this.transcriptionEngine,
      this.inputFormat,
      this.sampleRate,
      this.language,
      this.interimResults,
      this.silenceDurationMs
    );
  }
}

class TelnyxSTTSession implements RealtimeSTTSession {
  private ws: WebSocket | null = null;
  private apiKey: string;
  private transcriptionEngine: string;
  private inputFormat: string;
  private sampleRate: number;
  private language: string;
  private interimResults: boolean;
  private silenceDurationMs: number;
  private connected = false;
  private closed = false;

  private partialCallback: ((partial: string) => void) | null = null;
  private transcriptResolve: ((transcript: string) => void) | null = null;
  private transcriptReject: ((err: Error) => void) | null = null;
  private transcriptTimeout: NodeJS.Timeout | null = null;
  private pendingTranscript = '';

  constructor(
    apiKey: string,
    transcriptionEngine: string,
    inputFormat: string,
    sampleRate: number,
    language: string,
    interimResults: boolean,
    silenceDurationMs: number
  ) {
    this.apiKey = apiKey;
    this.transcriptionEngine = transcriptionEngine;
    this.inputFormat = inputFormat;
    this.sampleRate = sampleRate;
    this.language = language;
    this.interimResults = interimResults;
    this.silenceDurationMs = silenceDurationMs;
  }

  private buildUrl(): string {
    const params = new URLSearchParams({
      transcription_engine: this.transcriptionEngine,
      input_format: this.inputFormat,
      sample_rate: String(this.sampleRate),
      language: this.language,
    });
    if (this.interimResults) params.set('interim_results', 'true');
    return `wss://api.telnyx.com/v2/speech-to-text/transcription?${params.toString()}`;
  }

  async connect(): Promise<void> {
    this.closed = false;
    return this.doConnect();
  }

  private async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.buildUrl(), {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });

      // Abort the connect attempt if the server never opens the session.
      // Without this, a hung WebSocket would block initiateCall() forever.
      const connectTimeout = setTimeout(() => {
        if (!this.connected) {
          try { ws.removeAllListeners(); ws.close(); } catch {}
          reject(new Error('Telnyx STT connection timeout'));
        }
      }, 10000);

      ws.on('open', () => {
        clearTimeout(connectTimeout);
        this.connected = true;
        console.error('[Telnyx STT] Connected');
        resolve();
      });

      ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) return;
        let msg: any;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        const text = (msg.transcript || '').trim();
        if (!text) return;

        const isFinal = msg.is_final === true;
        if (isFinal) {
          this.pendingTranscript = this.pendingTranscript
            ? this.pendingTranscript + ' ' + text
            : text;
          if (this.transcriptResolve) {
            const full = this.pendingTranscript;
            this.pendingTranscript = '';
            if (this.transcriptTimeout) clearTimeout(this.transcriptTimeout);
            this.transcriptTimeout = null;
            const resolveFn = this.transcriptResolve;
            this.transcriptResolve = null;
            this.transcriptReject = null;
            resolveFn(full);
          }
        } else if (this.partialCallback) {
          this.partialCallback(text);
        }
      });

      ws.on('error', (err: Error) => {
        clearTimeout(connectTimeout);
        console.error(`[Telnyx STT] Error: ${err.message}`);
        if (!this.connected) reject(err);
        else if (this.transcriptReject) {
          const rejectFn = this.transcriptReject;
          this.transcriptReject = null;
          this.transcriptResolve = null;
          if (this.transcriptTimeout) clearTimeout(this.transcriptTimeout);
          rejectFn(err);
        }
      });

      ws.on('close', () => {
        this.connected = false;
        console.error('[Telnyx STT] Connection closed');
        if (this.transcriptReject && !this.closed) {
          const rejectFn = this.transcriptReject;
          this.transcriptReject = null;
          this.transcriptResolve = null;
          if (this.transcriptTimeout) clearTimeout(this.transcriptTimeout);
          rejectFn(new Error('Telnyx STT connection closed'));
        }
      });

      this.ws = ws;
    });
  }

  sendAudio(audio: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(audio);
  }

  async waitForTranscript(timeoutMs?: number): Promise<string> {
    // If finals already arrived before anyone was listening (e.g. the user
    // spoke during TTS playback), return the buffered transcript instead of
    // dropping it on the floor.
    if (this.pendingTranscript) {
      const full = this.pendingTranscript;
      this.pendingTranscript = '';
      return full;
    }
    const timeout = timeoutMs ?? (this.silenceDurationMs + 5000);
    return new Promise((resolve, reject) => {
      this.transcriptResolve = resolve;
      this.transcriptReject = reject;
      this.transcriptTimeout = setTimeout(() => {
        if (this.transcriptReject) {
          const rejectFn = this.transcriptReject;
          this.transcriptResolve = null;
          this.transcriptReject = null;
          rejectFn(new Error('Telnyx STT transcript timeout'));
        }
      }, timeout);
    });
  }

  onPartial(callback: (partial: string) => void): void {
    this.partialCallback = callback;
  }

  close(): void {
    this.closed = true;
    this.connected = false;
    if (this.transcriptTimeout) clearTimeout(this.transcriptTimeout);
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'CloseStream' }));
        }
        this.ws.close();
      } catch {}
    }
    this.ws = null;
  }

  isConnected(): boolean {
    return this.connected && !this.closed;
  }
}
