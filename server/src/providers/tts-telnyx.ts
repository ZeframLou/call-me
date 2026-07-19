/**
 * Telnyx TTS Provider
 *
 * Streaming text-to-speech via the Telnyx WebSocket API.
 * Endpoint: wss://api.telnyx.com/v2/text-to-speech/speech
 *
 * Uses the same Telnyx API key as the phone provider, so no extra
 * account or credential is needed when CALLME_PHONE_PROVIDER=telnyx.
 *
 * Returns a PCM audio buffer (16-bit, mono) matching the TTSProvider
 * interface. The phone bridge resamples to 8kHz and converts to mu-law
 * before sending to the caller.
 *
 * Protocol (per https://developers.telnyx.com/docs/tts-stt/tts-websocket-streaming):
 *   - Connect with Authorization: Bearer <key> header.
 *   - Voice and audio format are set via URL query params.
 *   - Send init frame { "text": " ", "voice_settings": { "voice_speed": N } }.
 *   - Send text frame { "text": "..." } for each synthesis request.
 *   - Receive JSON frames: { "audio": "<base64>", "isFinal": false } per chunk,
 *     then a final frame { "audio": null, "text": "", "isFinal": true }.
 *   - Send { "text": "" } to signal completion (NOT { "force": true }, which
 *     interrupts mid-stream synthesis).
 *
 * Audio format is "linear16" (16-bit signed LE PCM) at 24kHz mono, matching
 * the contract of TTSProvider.synthesize() and the resampler in phone-call.ts.
 * Valid Telnyx formats: mp3, linear16, wav, mulaw, alaw, ogg_vorbis.
 *
 * Voices: see GET https://api.telnyx.com/v2/text-to-speech/voices
 * for the full catalog (AWS Polly, Azure, Google, ElevenLabs, Resemble, xAI).
 * Default is AWS.Polly.Matthew-Neural (en-US male).
 */

import WebSocket from 'ws';
import type { TTSProvider, TTSConfig } from './types.js';

export class TelnyxTTSProvider implements TTSProvider {
  readonly name = 'telnyx';
  private apiKey: string | null = null;
  private voice: string = 'AWS.Polly.Matthew-Neural';
  private audioFormat: string = 'linear16';
  private sampleRate: number = 24000;

  initialize(config: TTSConfig): void {
    if (!config.apiKey) {
      throw new Error('Telnyx API key required for TTS');
    }
    this.apiKey = config.apiKey;
    this.voice = config.voice || 'AWS.Polly.Matthew-Neural';
    // "pcm" is not a valid Telnyx audio_format; the field default of
    // "linear16" is what we actually want when no override is given.
    this.audioFormat = (config as any).audioFormat || 'linear16';
    this.sampleRate = (config as any).sampleRate || 24000;
    console.error(`TTS provider: Telnyx (voice: ${this.voice}, ${this.sampleRate}Hz)`);
  }

  private buildUrl(): string {
    const params = new URLSearchParams({
      voice: this.voice,
      audio_format: this.audioFormat,
      sample_rate: String(this.sampleRate),
    });
    return `wss://api.telnyx.com/v2/text-to-speech/speech?${params.toString()}`;
  }

  async synthesize(text: string): Promise<Buffer> {
    if (!this.apiKey) throw new Error('Telnyx TTS not initialized');

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | null = null;
      const ws = new WebSocket(this.buildUrl(), {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });

      const cleanup = () => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        try { ws.removeAllListeners(); ws.close(); } catch {}
      };

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      ws.on('open', () => {
        // Init handshake frame (single space, required)
        ws.send(JSON.stringify({ text: ' ', voice_settings: { voice_speed: 1.0 } }));
        // Text to synthesize
        ws.send(JSON.stringify({ text }));
        // Stop frame: empty text signals completion per the Telnyx spec.
        // NOT { force: true }, which interrupts mid-stream synthesis.
        ws.send(JSON.stringify({ text: '' }));
      });

      ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) return;
        let msg: any;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }

        if (msg.error) {
          settle(() => reject(new Error(`Telnyx TTS error: ${msg.error}`)));
          return;
        }

        if (msg.audio) {
          const audioBytes = Buffer.from(msg.audio, 'base64');
          chunks.push(audioBytes);
        }

        if (msg.isFinal) {
          settle(() => resolve(Buffer.concat(chunks)));
        }
      });

      ws.on('error', (err: Error) => {
        settle(() => reject(new Error(`Telnyx TTS WebSocket error: ${err.message}`)));
      });

      ws.on('close', () => {
        // Server closed before isFinal. Resolve with whatever we have so
        // short utterances that flush quickly still play; reject only if we
        // got nothing at all.
        settle(() => {
          if (chunks.length > 0) {
            resolve(Buffer.concat(chunks));
          } else {
            reject(new Error('Telnyx TTS connection closed before audio received'));
          }
        });
      });

      // 30s timeout
      timeoutHandle = setTimeout(() => {
        settle(() => {
          if (chunks.length > 0) {
            resolve(Buffer.concat(chunks));
          } else {
            reject(new Error('Telnyx TTS timeout'));
          }
        });
      }, 30000);
    });
  }
}
