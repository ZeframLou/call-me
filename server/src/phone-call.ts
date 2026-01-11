import WebSocket, { WebSocketServer } from 'ws';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import {
  loadProviderConfig,
  createProviders,
  validateProviderConfig,
  type ProviderRegistry,
  type ProviderConfig,
  type RealtimeSTTSession,
} from './providers/index.js';
import {
  validateTwilioSignature,
  validateTelnyxSignature,
  generateWebSocketToken,
  validateWebSocketToken,
} from './webhook-security.js';

interface CallState {
  callId: string;
  callControlId: string | null;
  userPhoneNumber: string;
  ws: WebSocket | null;
  streamSid: string | null;  // Twilio media stream ID (required for sending audio)
  streamingReady: boolean;  // True when streaming.started event received (Telnyx)
  wsToken: string;  // Security token for WebSocket authentication
  conversationHistory: Array<{ speaker: 'claude' | 'user'; message: string }>;
  startTime: number;
  hungUp: boolean;
  sttSession: RealtimeSTTSession | null;
  pendingMessage: string;  // Message to send as SMS if call not answered
  answeredByMachine: boolean;  // Track if voicemail/machine answered
}

export interface ServerConfig {
  publicUrl: string;
  port: number;
  phoneNumber: string;
  userPhoneNumber: string;
  providers: ProviderRegistry;
  providerConfig: ProviderConfig;  // For webhook signature verification
  transcriptTimeoutMs: number;
  smsFallback: boolean;  // Send SMS if call not answered
}

export function loadServerConfig(publicUrl: string): ServerConfig {
  const providerConfig = loadProviderConfig();
  const errors = validateProviderConfig(providerConfig);

  if (!process.env.CALLME_USER_PHONE_NUMBER) {
    errors.push('Missing CALLME_USER_PHONE_NUMBER (where to call you)');
  }

  if (errors.length > 0) {
    throw new Error(`Missing required configuration:\n  - ${errors.join('\n  - ')}`);
  }

  const providers = createProviders(providerConfig);

  // Default 3 minutes for transcript timeout
  const transcriptTimeoutMs = parseInt(process.env.CALLME_TRANSCRIPT_TIMEOUT_MS || '180000', 10);

  // SMS fallback enabled by default, set CALLME_SMS_FALLBACK=false to disable
  const smsFallback = process.env.CALLME_SMS_FALLBACK !== 'false';

  return {
    publicUrl,
    port: parseInt(process.env.CALLME_PORT || '3333', 10),
    phoneNumber: providerConfig.phoneNumber,
    userPhoneNumber: process.env.CALLME_USER_PHONE_NUMBER!,
    providers,
    providerConfig,
    transcriptTimeoutMs,
    smsFallback,
  };
}

export class CallManager {
  private activeCalls = new Map<string, CallState>();
  private callControlIdToCallId = new Map<string, string>();
  private wsTokenToCallId = new Map<string, string>();  // For WebSocket auth
  private httpServer: ReturnType<typeof createServer> | null = null;
  private wss: WebSocketServer | null = null;
  private config: ServerConfig;
  private currentCallId = 0;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  startServer(): void {
    this.httpServer = createServer((req, res) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);

      if (url.pathname === '/twiml') {
        this.handlePhoneWebhook(req, res);
        return;
      }

      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', activeCalls: this.activeCalls.size }));
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    this.wss = new WebSocketServer({ noServer: true });

    this.httpServer.on('upgrade', (request: IncomingMessage, socket: any, head: Buffer) => {
      const url = new URL(request.url!, `http://${request.headers.host}`);
      if (url.pathname === '/media-stream') {
        // Try to find the call ID from token
        const token = url.searchParams.get('token');
        let callId = token ? this.wsTokenToCallId.get(token) : null;

        // Validate token if provided
        if (token && callId) {
          const state = this.activeCalls.get(callId);
          if (!state || !validateWebSocketToken(state.wsToken, token)) {
            console.error('[Security] Rejecting WebSocket: token validation failed');
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
          console.error(`[Security] WebSocket token validated for call ${callId}`);
        } else if (!callId) {
          // Token missing or not found - only allow fallback for ngrok free tier
          const hostname = new URL(this.config.publicUrl).hostname;
          const isNgrokFreeTier = hostname.endsWith('.ngrok-free.dev') || hostname.endsWith('.ngrok-free.app');
          if (isNgrokFreeTier) {
            // Fallback: find the most recent active call (ngrok compatibility mode)
            // Token lookup can fail due to timing issues with ngrok's free tier
            const activeCallIds = Array.from(this.activeCalls.keys());
            if (activeCallIds.length > 0) {
              callId = activeCallIds[activeCallIds.length - 1];
              console.error(`[WebSocket] Token not found, using fallback call ID: ${callId} (ngrok compatibility mode)`);
            } else {
              // No active calls yet - create a placeholder and accept anyway
              // The connection handler will associate it with the correct call
              callId = `pending-${Date.now()}`;
              console.error(`[WebSocket] No active calls, using placeholder: ${callId} (ngrok compatibility mode)`);
            }
          } else {
            console.error('[Security] Rejecting WebSocket: missing or invalid token');
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
        }

        // Accept WebSocket connection
        console.error(`[WebSocket] Accepting connection for: ${callId}`);
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.wss!.emit('connection', ws, request, callId);
        });
      } else {
        socket.destroy();
      }
    });

    this.wss.on('connection', (ws: WebSocket, _request: IncomingMessage, callId: string) => {
      console.error(`Media stream WebSocket connected for call ${callId}`);

      // Associate the WebSocket with the call immediately (token already validated)
      const state = this.activeCalls.get(callId);
      if (state) {
        state.ws = ws;
      }

      ws.on('message', (message: Buffer | string) => {
        const msgBuffer = Buffer.isBuffer(message) ? message : Buffer.from(message);

        // Parse JSON messages from Twilio to capture streamSid and handle events
        if (msgBuffer.length > 0 && msgBuffer[0] === 0x7b) {
          try {
            const msg = JSON.parse(msgBuffer.toString());
            const msgState = this.activeCalls.get(callId);

            // Capture streamSid from "start" event (required for sending audio back)
            if (msg.event === 'start' && msg.streamSid && msgState) {
              msgState.streamSid = msg.streamSid;
              console.error(`[${callId}] Captured streamSid: ${msg.streamSid}`);
            }

            // Handle "stop" event when call ends
            if (msg.event === 'stop' && msgState) {
              console.error(`[${callId}] Stream stopped`);
              msgState.hungUp = true;
            }
          } catch { }
        }

        // Forward audio to realtime transcription session
        const audioState = this.activeCalls.get(callId);
        if (audioState?.sttSession) {
          const audioData = this.extractInboundAudio(msgBuffer);
          if (audioData) {
            audioState.sttSession.sendAudio(audioData);
          }
        }
      });

      ws.on('close', () => {
        console.error('Media stream WebSocket closed');
      });
    });

    this.httpServer.listen(this.config.port, () => {
      console.error(`HTTP server listening on port ${this.config.port}`);
    });
  }

  /**
   * Extract INBOUND audio data from WebSocket message (filters out outbound/TTS audio)
   */
  private extractInboundAudio(msgBuffer: Buffer): Buffer | null {
    if (msgBuffer.length === 0) return null;

    // Binary audio (doesn't start with '{') - can't determine track, skip
    if (msgBuffer[0] !== 0x7b) {
      return null;
    }

    // JSON format - only extract inbound track (user's voice)
    try {
      const msg = JSON.parse(msgBuffer.toString());
      if (msg.event === 'media' && msg.media?.payload) {
        const track = msg.media?.track;
        if (track === 'inbound' || track === 'inbound_track') {
          return Buffer.from(msg.media.payload, 'base64');
        }
      }
    } catch { }

    return null;
  }

  private handlePhoneWebhook(req: IncomingMessage, res: ServerResponse): void {
    const contentType = req.headers['content-type'] || '';

    // Telnyx sends JSON webhooks
    if (contentType.includes('application/json')) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          // Validate Telnyx signature if public key is configured
          const telnyxPublicKey = this.config.providerConfig.telnyxPublicKey;
          if (telnyxPublicKey) {
            const signature = req.headers['telnyx-signature-ed25519'] as string | undefined;
            const timestamp = req.headers['telnyx-timestamp'] as string | undefined;

            if (!validateTelnyxSignature(telnyxPublicKey, signature, timestamp, body)) {
              console.error('[Security] Rejecting Telnyx webhook: invalid signature');
              res.writeHead(401);
              res.end('Invalid signature');
              return;
            }
          } else {
            console.error('[Security] Warning: CALLME_TELNYX_PUBLIC_KEY not set, skipping signature verification');
          }

          const event = JSON.parse(body);
          await this.handleTelnyxWebhook(event, res);
        } catch (error) {
          console.error('Error parsing webhook:', error);
          res.writeHead(400);
          res.end('Invalid JSON');
        }
      });
      return;
    }

    // Twilio sends form-urlencoded webhooks
    if (contentType.includes('application/x-www-form-urlencoded')) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const params = new URLSearchParams(body);

          // Validate Twilio signature
          const authToken = this.config.providerConfig.phoneAuthToken;
          const signature = req.headers['x-twilio-signature'] as string | undefined;
          // Use the known public URL directly - reconstructing from headers fails with ngrok
          // because ngrok doesn't preserve headers exactly as Twilio sends them
          const webhookUrl = `${this.config.publicUrl}/twiml`;

          if (!validateTwilioSignature(authToken, signature, webhookUrl, params)) {
            const hostname = new URL(this.config.publicUrl).hostname;
          const isNgrokFreeTier = hostname.endsWith('.ngrok-free.dev') || hostname.endsWith('.ngrok-free.app');
            if (isNgrokFreeTier) {
              // Only log if ngrok free tier is used
              // Log for debugging but proceed anyway - ngrok free tier causes signature mismatches
              console.error('[Security] Twilio signature validation failed (proceeding anyway for ngrok compatibility)');
            } else {
              console.error('[Security] Rejecting Twilio webhook: invalid signature');
              res.writeHead(401);
              res.end('Invalid signature');
              return;
            }
          }

          await this.handleTwilioWebhook(params, res);
        } catch (error) {
          console.error('Error parsing Twilio webhook:', error);
          res.writeHead(400);
          res.end('Invalid form data');
        }
      });
      return;
    }

    // Fallback: Reject unknown content types
    console.error('[Security] Rejecting webhook with unknown content type:', contentType);
    res.writeHead(400);
    res.end('Invalid content type');
  }

  private async handleTwilioWebhook(params: URLSearchParams, res: ServerResponse): Promise<void> {
    const callSid = params.get('CallSid');
    const callStatus = params.get('CallStatus');
    const answeredBy = params.get('AnsweredBy');  // AMD result: human, machine_start, machine_end_beep, etc.

    console.error(`Twilio webhook: CallSid=${callSid}, CallStatus=${callStatus}, AnsweredBy=${answeredBy}`);

    // Track AMD result when we receive it (comes in early webhooks, not in "completed")
    if (callSid && answeredBy?.startsWith('machine')) {
      const callId = this.callControlIdToCallId.get(callSid);
      if (callId) {
        const state = this.activeCalls.get(callId);
        if (state) {
          state.answeredByMachine = true;
          console.error(`[${callId}] AMD detected: ${answeredBy}`);
        }
      }
    }

    // Handle call status updates
    if (callStatus === 'completed' || callStatus === 'busy' || callStatus === 'no-answer' || callStatus === 'failed') {
      // Call ended - find and mark as hung up
      if (callSid) {
        const callId = this.callControlIdToCallId.get(callSid);
        if (callId) {
          this.callControlIdToCallId.delete(callSid);
          const state = this.activeCalls.get(callId);
          if (state) {
            // Determine if we should send SMS fallback:
            // - no-answer, busy, failed: call didn't connect
            // - completed + machine: voicemail answered (tracked from earlier AMD webhook)
            const callNotAnsweredByHuman =
              callStatus === 'no-answer' ||
              callStatus === 'busy' ||
              callStatus === 'failed' ||
              (callStatus === 'completed' && state.answeredByMachine);

            // Send SMS fallback if call was not answered by human and SMS fallback is enabled
            if (callNotAnsweredByHuman &&
                this.config.smsFallback &&
                state.pendingMessage &&
                this.config.providers.phone.sendSMS) {
              try {
                await this.config.providers.phone.sendSMS(
                  state.userPhoneNumber,
                  this.config.phoneNumber,
                  `[Claude] ${state.pendingMessage}`
                );
                console.error(`[${callId}] Call ${callStatus} (machine: ${state.answeredByMachine}), sent SMS fallback`);
              } catch (error) {
                console.error(`[${callId}] Failed to send SMS fallback:`, error);
              }
            }
            state.hungUp = true;
            state.ws?.close();
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      return;
    }

    // For 'in-progress' or 'ringing' status, return TwiML to start media stream
    // Include security token in the stream URL
    let streamUrl = `wss://${new URL(this.config.publicUrl).host}/media-stream`;

    // Find the call state to get the WebSocket token
    if (callSid) {
      const callId = this.callControlIdToCallId.get(callSid);
      if (callId) {
        const state = this.activeCalls.get(callId);
        if (state) {
          streamUrl += `?token=${encodeURIComponent(state.wsToken)}`;
        }
      }
    }

    const xml = this.config.providers.phone.getStreamConnectXml(streamUrl);
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(xml);
  }

  private async handleTelnyxWebhook(event: any, res: ServerResponse): Promise<void> {
    const eventType = event.data?.event_type;
    const callControlId = event.data?.payload?.call_control_id;

    console.error(`Phone webhook: ${eventType}`);

    // Always respond 200 OK immediately
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));

    if (!callControlId) return;

    try {
      switch (eventType) {
        case 'call.initiated':
          break;

        case 'call.answered':
          // Include security token in the stream URL
          let streamUrl = `wss://${new URL(this.config.publicUrl).host}/media-stream`;
          const callId = this.callControlIdToCallId.get(callControlId);
          if (callId) {
            const state = this.activeCalls.get(callId);
            if (state) {
              streamUrl += `?token=${encodeURIComponent(state.wsToken)}`;
            }
          }
          await this.config.providers.phone.startStreaming(callControlId, streamUrl);
          console.error(`Started streaming for call ${callControlId}`);
          break;

        case 'call.hangup':
          const hangupCallId = this.callControlIdToCallId.get(callControlId);
          if (hangupCallId) {
            this.callControlIdToCallId.delete(callControlId);
            const hangupState = this.activeCalls.get(hangupCallId);
            if (hangupState) {
              hangupState.hungUp = true;
              hangupState.ws?.close();
            }
          }
          break;

        case 'call.machine.detection.ended':
          const result = event.data?.payload?.result;
          console.error(`AMD result: ${result}`);
          break;

        case 'streaming.started':
          const streamCallId = this.callControlIdToCallId.get(callControlId);
          if (streamCallId) {
            const streamState = this.activeCalls.get(streamCallId);
            if (streamState) {
              streamState.streamingReady = true;
              console.error(`[${streamCallId}] Streaming ready`);
            }
          }
          break;

        case 'streaming.stopped':
          break;
      }
    } catch (error) {
      console.error(`Error handling webhook ${eventType}:`, error);
    }
  }

  async initiateCall(message: string): Promise<{ callId: string; response: string }> {
    const callId = `call-${++this.currentCallId}-${Date.now()}`;

    // Create realtime transcription session via provider
    const sttSession = this.config.providers.stt.createSession();
    await sttSession.connect();
    console.error(`[${callId}] STT session connected`);

    // Generate secure token for WebSocket authentication
    const wsToken = generateWebSocketToken();

    const state: CallState = {
      callId,
      callControlId: null,
      userPhoneNumber: this.config.userPhoneNumber,
      ws: null,
      streamSid: null,
      streamingReady: false,
      wsToken,
      conversationHistory: [],
      startTime: Date.now(),
      hungUp: false,
      sttSession,
      pendingMessage: message,  // Store for SMS fallback if call not answered
      answeredByMachine: false,  // Will be set true if AMD detects voicemail
    };

    this.activeCalls.set(callId, state);

    try {
      const callControlId = await this.config.providers.phone.initiateCall(
        this.config.userPhoneNumber,
        this.config.phoneNumber,
        `${this.config.publicUrl}/twiml`
      );

      state.callControlId = callControlId;
      this.callControlIdToCallId.set(callControlId, callId);
      this.wsTokenToCallId.set(wsToken, callId);

      console.error(`Call initiated: ${callControlId} -> ${this.config.userPhoneNumber}`);

      // Start TTS generation in parallel with waiting for connection
      // This reduces latency by generating audio while Twilio establishes the stream
      const ttsPromise = this.generateTTSAudio(message);

      await this.waitForConnection(callId, 15000);

      // Send the pre-generated audio and listen for response
      const audioData = await ttsPromise;
      await this.sendPreGeneratedAudio(state, audioData);
      const response = await this.listen(state);
      state.conversationHistory.push({ speaker: 'claude', message });
      state.conversationHistory.push({ speaker: 'user', message: response });

      return { callId, response };
    } catch (error) {
      state.sttSession?.close();
      this.activeCalls.delete(callId);
      throw error;
    }
  }

  async continueCall(callId: string, message: string): Promise<string> {
    const state = this.activeCalls.get(callId);
    if (!state) throw new Error(`No active call: ${callId}`);

    const response = await this.speakAndListen(state, message);
    state.conversationHistory.push({ speaker: 'claude', message });
    state.conversationHistory.push({ speaker: 'user', message: response });

    return response;
  }

  async speakOnly(callId: string, message: string): Promise<void> {
    const state = this.activeCalls.get(callId);
    if (!state) throw new Error(`No active call: ${callId}`);

    await this.speak(state, message);
    state.conversationHistory.push({ speaker: 'claude', message });
  }

  async endCall(callId: string, message: string): Promise<{ durationSeconds: number }> {
    const state = this.activeCalls.get(callId);
    if (!state) throw new Error(`No active call: ${callId}`);

    await this.speak(state, message);

    // Wait for audio to finish playing before hanging up (prevent cutoff)
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Send SMS fallback if call was answered by machine (voicemail)
    if (state.answeredByMachine &&
        this.config.smsFallback &&
        state.pendingMessage &&
        this.config.providers.phone.sendSMS) {
      try {
        await this.config.providers.phone.sendSMS(
          state.userPhoneNumber,
          this.config.phoneNumber,
          `[Claude] ${state.pendingMessage}`
        );
        console.error(`[${callId}] Voicemail detected, sent SMS fallback`);
      } catch (error) {
        console.error(`[${callId}] Failed to send SMS fallback:`, error);
      }
    }

    // Hang up the call via phone provider
    if (state.callControlId) {
      await this.config.providers.phone.hangup(state.callControlId);
    }

    // Close sessions and clean up mappings
    state.sttSession?.close();
    state.ws?.close();
    state.hungUp = true;

    // Clean up security token mapping
    this.wsTokenToCallId.delete(state.wsToken);
    if (state.callControlId) {
      this.callControlIdToCallId.delete(state.callControlId);
    }

    const durationSeconds = Math.round((Date.now() - state.startTime) / 1000);
    this.activeCalls.delete(callId);

    return { durationSeconds };
  }

  private async waitForConnection(callId: string, timeout: number): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const state = this.activeCalls.get(callId);
      // Wait for WebSocket AND streaming to be ready:
      // - Twilio: streamSid is set from "start" WebSocket event
      // - Telnyx: streamingReady is set from "streaming.started" webhook
      const wsReady = state?.ws && state.ws.readyState === WebSocket.OPEN;
      const streamReady = state?.streamSid || state?.streamingReady;
      if (wsReady && streamReady) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('WebSocket connection timeout');
  }

  /**
   * Pre-generate TTS audio (can run in parallel with connection setup)
   * Returns mu-law encoded audio ready to send to Twilio
   */
  private async generateTTSAudio(text: string): Promise<Buffer> {
    console.error(`[TTS] Generating audio for: ${text.substring(0, 50)}...`);
    const tts = this.config.providers.tts;
    const pcmData = await tts.synthesize(text);
    const resampledPcm = this.resample24kTo8k(pcmData);
    const muLawData = this.pcmToMuLaw(resampledPcm);
    console.error(`[TTS] Audio generated: ${muLawData.length} bytes`);
    return muLawData;
  }

  /**
   * Send a single audio chunk to the phone via WebSocket
   */
  private sendMediaChunk(state: CallState, audioData: Buffer): void {
    if (state.ws?.readyState !== WebSocket.OPEN) return;
    const message: Record<string, unknown> = {
      event: 'media',
      media: { payload: audioData.toString('base64') },
    };
    if (state.streamSid) {
      message.streamSid = state.streamSid;
    }
    state.ws.send(JSON.stringify(message));
  }

  private async sendPreGeneratedAudio(state: CallState, muLawData: Buffer): Promise<void> {
    console.error(`[${state.callId}] Sending pre-generated audio...`);
    const chunkSize = 160;  // 20ms at 8kHz
    for (let i = 0; i < muLawData.length; i += chunkSize) {
      this.sendMediaChunk(state, muLawData.subarray(i, i + chunkSize));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Small delay to ensure audio finishes playing before listening
    await new Promise((resolve) => setTimeout(resolve, 200));
    console.error(`[${state.callId}] Audio sent`);
  }

  private async speakAndListen(state: CallState, text: string): Promise<string> {
    await this.speak(state, text);
    return await this.listen(state);
  }

  private async speak(state: CallState, text: string): Promise<void> {
    console.error(`[${state.callId}] Speaking: ${text.substring(0, 50)}...`);

    const tts = this.config.providers.tts;

    // Use streaming if available for lower latency
    if (tts.synthesizeStream) {
      await this.speakStreaming(state, text, tts.synthesizeStream.bind(tts));
    } else {
      const pcmData = await tts.synthesize(text);
      await this.sendAudio(state, pcmData);
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
    console.error(`[${state.callId}] Speaking done`);
  }

  private async speakStreaming(
    state: CallState,
    text: string,
    synthesizeStream: (text: string) => AsyncGenerator<Buffer>
  ): Promise<void> {
    let pendingPcm = Buffer.alloc(0);
    let pendingMuLaw = Buffer.alloc(0);
    const OUTPUT_CHUNK_SIZE = 160; // 20ms at 8kHz
    const SAMPLES_PER_RESAMPLE = 6; // 6 bytes (3 samples) at 24kHz -> 1 sample at 8kHz

    // Jitter buffer: accumulate audio before starting playback to smooth out
    // timing variations from network latency and burst delivery patterns
    const JITTER_BUFFER_MS = 100; // Buffer 100ms of audio before starting
    // 8000 samples/sec ÷ 1000 ms/sec = 8 samples per ms; mu-law is 1 byte per sample
    const JITTER_BUFFER_SIZE = (8000 / 1000) * JITTER_BUFFER_MS; // 800 bytes at 8kHz mu-law
    let playbackStarted = false;

    // Helper to drain and send buffered mu-law audio in chunks
    const drainBuffer = async () => {
      while (pendingMuLaw.length >= OUTPUT_CHUNK_SIZE) {
        this.sendMediaChunk(state, pendingMuLaw.subarray(0, OUTPUT_CHUNK_SIZE));
        pendingMuLaw = pendingMuLaw.subarray(OUTPUT_CHUNK_SIZE);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };

    for await (const chunk of synthesizeStream(text)) {
      pendingPcm = Buffer.concat([pendingPcm, chunk]);

      const completeUnits = Math.floor(pendingPcm.length / SAMPLES_PER_RESAMPLE);
      if (completeUnits > 0) {
        const bytesToProcess = completeUnits * SAMPLES_PER_RESAMPLE;
        const toProcess = pendingPcm.subarray(0, bytesToProcess);
        pendingPcm = pendingPcm.subarray(bytesToProcess);

        const resampled = this.resample24kTo8k(toProcess);
        const muLaw = this.pcmToMuLaw(resampled);
        pendingMuLaw = Buffer.concat([pendingMuLaw, muLaw]);

        // Wait for jitter buffer to fill before starting playback
        if (!playbackStarted && pendingMuLaw.length < JITTER_BUFFER_SIZE) {
          continue;
        }
        playbackStarted = true;

        await drainBuffer();
      }
    }

    // Send remaining audio (including any buffered audio for short messages)
    await drainBuffer();

    // Send any final partial chunk
    if (pendingMuLaw.length > 0) {
      this.sendMediaChunk(state, pendingMuLaw);
    }
  }

  private async sendAudio(state: CallState, pcmData: Buffer): Promise<void> {
    const resampledPcm = this.resample24kTo8k(pcmData);
    const muLawData = this.pcmToMuLaw(resampledPcm);

    const chunkSize = 160;
    for (let i = 0; i < muLawData.length; i += chunkSize) {
      this.sendMediaChunk(state, muLawData.subarray(i, i + chunkSize));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  private async listen(state: CallState): Promise<string> {
    console.error(`[${state.callId}] Listening...`);

    if (!state.sttSession) {
      throw new Error('STT session not available');
    }

    // Race between getting a transcript and detecting hangup
    const transcript = await Promise.race([
      state.sttSession.waitForTranscript(this.config.transcriptTimeoutMs),
      this.waitForHangup(state),
    ]);

    if (state.hungUp) {
      throw new Error('Call was hung up by user');
    }

    console.error(`[${state.callId}] User said: ${transcript}`);
    return transcript;
  }

  /**
   * Returns a promise that rejects when the call is hung up.
   * Used to race against transcript waiting.
   */
  private waitForHangup(state: CallState): Promise<never> {
    return new Promise((_, reject) => {
      const checkInterval = setInterval(() => {
        if (state.hungUp) {
          clearInterval(checkInterval);
          reject(new Error('Call was hung up by user'));
        }
      }, 100);  // Check every 100ms

      // Clean up interval after transcript timeout to avoid memory leaks
      setTimeout(() => {
        clearInterval(checkInterval);
      }, this.config.transcriptTimeoutMs + 1000);
    });
  }

  private resample24kTo8k(pcmData: Buffer): Buffer {
    const inputSamples = pcmData.length / 2;
    const outputSamples = Math.floor(inputSamples / 3);
    const output = Buffer.alloc(outputSamples * 2);

    for (let i = 0; i < outputSamples; i++) {
      // Use linear interpolation instead of point-sampling to reduce artifacts
      // For each output sample, average the 3 surrounding input samples
      // This acts as a simple anti-aliasing low-pass filter
      const baseIdx = i * 3;
      const s0 = pcmData.readInt16LE(baseIdx * 2);
      const s1 = baseIdx + 1 < inputSamples ? pcmData.readInt16LE((baseIdx + 1) * 2) : s0;
      const s2 = baseIdx + 2 < inputSamples ? pcmData.readInt16LE((baseIdx + 2) * 2) : s1;
      const interpolated = Math.round((s0 + s1 + s2) / 3);
      output.writeInt16LE(interpolated, i * 2);
    }

    return output;
  }

  private pcmToMuLaw(pcmData: Buffer): Buffer {
    const muLawData = Buffer.alloc(Math.floor(pcmData.length / 2));
    for (let i = 0; i < muLawData.length; i++) {
      const pcm = pcmData.readInt16LE(i * 2);
      muLawData[i] = this.pcmToMuLawSample(pcm);
    }
    return muLawData;
  }

  private pcmToMuLawSample(pcm: number): number {
    const BIAS = 0x84;
    const CLIP = 32635;
    let sign = (pcm >> 8) & 0x80;
    if (sign) pcm = -pcm;
    if (pcm > CLIP) pcm = CLIP;
    pcm += BIAS;
    let exponent = 7;
    for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; exponent--) {
      expMask >>= 1;
    }
    const mantissa = (pcm >> (exponent + 3)) & 0x0f;
    return (~(sign | (exponent << 4) | mantissa)) & 0xff;
  }

  getHttpServer() {
    return this.httpServer;
  }

  shutdown(): void {
    for (const callId of this.activeCalls.keys()) {
      this.endCall(callId, 'Goodbye!').catch(console.error);
    }
    this.wss?.close();
    this.httpServer?.close();
  }
}
