/**
 * Telnyx Phone Provider (API v2)
 *
 * Cost-effective alternative to Twilio (30-70% cheaper).
 * Uses Call Control API v2 with JSON webhooks.
 *
 * Pricing (as of 2025):
 * - Outbound: $0.007/min (vs Twilio $0.014/min)
 * - Inbound: $0.0055/min (vs Twilio $0.0085/min)
 */

import type { PhoneProvider, PhoneConfig } from './types.js';

interface TelnyxCallResponse {
  data: {
    id: string;
    call_control_id: string;
    call_leg_id: string;
    record_type: string;
  };
}

export class TelnyxPhoneProvider implements PhoneProvider {
  readonly name = 'telnyx';
  private apiKey: string | null = null;
  private connectionId: string | null = null;

  initialize(config: PhoneConfig): void {
    // Telnyx uses API key (passed as authToken) and Connection ID (passed as accountSid)
    this.apiKey = config.authToken;
    this.connectionId = config.accountSid;
    console.error(`Phone provider: Telnyx (API v2)`);
  }

  async initiateCall(to: string, from: string, webhookUrl: string): Promise<string> {
    if (!this.apiKey || !this.connectionId) {
      throw new Error('Telnyx not initialized');
    }

    console.error(`[Telnyx] Initiating call: ${from} -> ${to}`);
    console.error(`[Telnyx] Webhook URL: ${webhookUrl}`);
    console.error(`[Telnyx] Connection ID: ${this.connectionId}`);

    const response = await fetch('https://api.telnyx.com/v2/calls', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        connection_id: this.connectionId,
        to,
        from,
        webhook_url: webhookUrl,
        webhook_url_method: 'POST',
        answering_machine_detection: 'detect',
        timeout_secs: 60,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorDetail = errorText;

      // Try to parse as JSON for better error messages
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.errors && Array.isArray(errorJson.errors)) {
          errorDetail = errorJson.errors
            .map((e: { title?: string; detail?: string; code?: string }) =>
              `${e.title || 'Error'}: ${e.detail || e.code || 'Unknown'}`
            )
            .join('; ');
        } else if (errorJson.error) {
          errorDetail = errorJson.error;
        }
      } catch {
        // Keep original error text if not JSON
      }

      console.error(`[Telnyx] Call initiation failed: ${response.status} - ${errorDetail}`);
      throw new Error(`Telnyx call failed (${response.status}): ${errorDetail}`);
    }

    const data = await response.json() as TelnyxCallResponse;
    console.error(`[Telnyx] Call created successfully. Control ID: ${data.data.call_control_id}`);
    return data.data.call_control_id;
  }

  /**
   * Start media streaming using Call Control API v2
   * Enables bidirectional streaming so we can send audio back to the caller
   */
  async startStreaming(callControlId: string, streamUrl: string): Promise<void> {
    if (!this.apiKey) {
      throw new Error('Telnyx not initialized');
    }

    const response = await fetch(
      `https://api.telnyx.com/v2/calls/${callControlId}/actions/streaming_start`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          stream_url: streamUrl,
          stream_track: 'both_tracks',
          // Enable bidirectional streaming to send audio back to caller
          stream_bidirectional_mode: 'rtp',
          // Use PCMU (mu-law) codec at 8kHz - matches our audio encoding
          stream_bidirectional_codec: 'PCMU',
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Telnyx streaming_start failed: ${response.status} ${error}`);
    }
  }

  /**
   * Answer an incoming call using Call Control API v2
   */
  async answerCall(callControlId: string): Promise<void> {
    if (!this.apiKey) {
      throw new Error('Telnyx not initialized');
    }

    const response = await fetch(
      `https://api.telnyx.com/v2/calls/${callControlId}/actions/answer`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Telnyx answer failed: ${response.status} ${error}`);
    }
  }

  /**
   * Hang up a call using Call Control API v2
   */
  async hangup(callControlId: string): Promise<void> {
    if (!this.apiKey) {
      throw new Error('Telnyx not initialized');
    }

    const response = await fetch(
      `https://api.telnyx.com/v2/calls/${callControlId}/actions/hangup`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error(`Telnyx hangup failed: ${response.status} ${error}`);
    }
  }

  /**
   * Speak text on a call using Telnyx's built-in TTS
   * This is more reliable than streaming audio via WebSocket
   */
  async speak(callControlId: string, text: string): Promise<void> {
    if (!this.apiKey) {
      throw new Error('Telnyx not initialized');
    }

    const response = await fetch(
      `https://api.telnyx.com/v2/calls/${callControlId}/actions/speak`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          payload: text,
          voice: 'male',
          language: 'en-US',
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Telnyx speak failed: ${response.status} ${error}`);
    }
  }

  // Legacy method for Twilio compatibility - not used with API v2
  getStreamConnectXml(streamUrl: string): string {
    // For API v2, we use startStreaming() instead
    // This is kept for interface compatibility but shouldn't be called
    console.error('Warning: getStreamConnectXml called on Telnyx v2 provider');
    return '';
  }
}
