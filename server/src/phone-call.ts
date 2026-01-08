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
  direction: 'inbound' | 'outbound';  // Call direction
}

export interface ServerConfig {
  publicUrl: string;
  port: number;
  phoneNumber: string;
  userPhoneNumber: string;
  providers: ProviderRegistry;
  providerConfig: ProviderConfig;  // For webhook signature verification
  transcriptTimeoutMs: number;
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

  return {
    publicUrl,
    port: parseInt(process.env.CALLME_PORT || '3333', 10),
    phoneNumber: providerConfig.phoneNumber,
    userPhoneNumber: process.env.CALLME_USER_PHONE_NUMBER!,
    providers,
    providerConfig,
    transcriptTimeoutMs,
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
        // Validate WebSocket token before allowing connection
        const token = url.searchParams.get('token');
        const callId = token ? this.wsTokenToCallId.get(token) : null;

        if (!token || !callId) {
          console.error('[Security] Rejecting WebSocket: missing or invalid token');
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        const state = this.activeCalls.get(callId);
        if (!state || !validateWebSocketToken(state.wsToken, token)) {
          console.error('[Security] Rejecting WebSocket: token validation failed');
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        // Token valid - proceed with upgrade
        console.error(`[Security] WebSocket token validated for call ${callId}`);
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
          } catch {}
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
    } catch {}

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
          // Reconstruct the URL Twilio used (handle ngrok SSL termination)
          const protocol = req.headers['x-forwarded-proto'] || 'https';
          const host = req.headers['host'] || new URL(this.config.publicUrl).host;
          const webhookUrl = `${protocol}://${host}${req.url}`;

          if (!validateTwilioSignature(authToken, signature, webhookUrl, params)) {
            console.error('[Security] Rejecting Twilio webhook: invalid signature');
            res.writeHead(401);
            res.end('Invalid signature');
            return;
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
    const callDirection = params.get('Direction'); // 'inbound' or 'outbound-dial'

    console.error(`Twilio webhook: CallSid=${callSid}, CallStatus=${callStatus}, Direction=${callDirection}`);

    // DETECT INCOMING CALL
    if (callDirection === 'inbound' && (callStatus === 'ringing' || callStatus === 'in-progress')) {
      const fromNumber = params.get('From') || '';

      // Check authorization
      if (!this.isCallerAllowed(fromNumber)) {
        console.error(`[Security] Rejecting call from unauthorized number: ${fromNumber}`);
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end('<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>');
        return;
      }

      // Create call state if not yet created
      let callId = this.callControlIdToCallId.get(callSid!);
      if (!callId) {
        callId = await this.handleIncomingCall(callSid!, fromNumber, 'twilio');
        this.callControlIdToCallId.set(callSid!, callId);
      }

      // Return TwiML to connect WebSocket stream
      const state = this.activeCalls.get(callId);
      if (state) {
        const streamUrl = `wss://${new URL(this.config.publicUrl).host}/media-stream?token=${encodeURIComponent(state.wsToken)}`;
        const xml = this.config.providers.phone.getStreamConnectXml(streamUrl);
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end(xml);

        // Start conversation in background
        this.startInboundConversation(callId).catch(error => {
          console.error(`[${callId}] Error starting conversation:`, error);
        });
        return;
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
        case 'call.initiated': {
          const callDirection = event.data?.payload?.direction;
          const fromNumber = event.data?.payload?.from?.phone_number || '';

          // DETECT INCOMING CALL
          if (callDirection === 'incoming') {
            // Check authorization
            if (!this.isCallerAllowed(fromNumber)) {
              console.error(`[Security] Rejecting incoming call from: ${fromNumber}`);
              await this.config.providers.phone.hangup(callControlId);
              return;
            }

            // Create call state
            const callId = await this.handleIncomingCall(callControlId, fromNumber, 'telnyx');
            this.callControlIdToCallId.set(callControlId, callId);
          }
          break;
        }

        case 'call.answered': {
          const callId = this.callControlIdToCallId.get(callControlId);
          const state = callId ? this.activeCalls.get(callId) : null;

          // Start streaming
          let streamUrl = `wss://${new URL(this.config.publicUrl).host}/media-stream`;
          if (state) {
            streamUrl += `?token=${encodeURIComponent(state.wsToken)}`;
          }
          await this.config.providers.phone.startStreaming(callControlId, streamUrl);
          console.error(`Started streaming for call ${callControlId}`);

          // If inbound call, start conversation
          if (state && state.direction === 'inbound') {
            this.startInboundConversation(callId).catch(error => {
              console.error(`[${callId}] Error starting conversation:`, error);
            });
          }
          break;
        }

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
      direction: 'outbound',
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

  /**
   * Handle an incoming call by creating the call state
   */
  private async handleIncomingCall(
    callControlId: string,
    fromPhoneNumber: string,
    provider: 'telnyx' | 'twilio'
  ): Promise<string> {
    const callId = `call-inbound-${++this.currentCallId}-${Date.now()}`;

    // Create STT session
    const sttSession = this.config.providers.stt.createSession();
    await sttSession.connect();

    // Generate WebSocket security token
    const wsToken = generateWebSocketToken();

    // Create call state
    const state: CallState = {
      callId,
      callControlId,
      userPhoneNumber: fromPhoneNumber,
      ws: null,
      streamSid: null,
      streamingReady: false,
      wsToken,
      conversationHistory: [],
      startTime: Date.now(),
      hungUp: false,
      sttSession,
      direction: 'inbound',
    };

    this.activeCalls.set(callId, state);
    this.callControlIdToCallId.set(callControlId, callId);
    this.wsTokenToCallId.set(wsToken, callId);

    // Auto-answer (Telnyx only, Twilio answers via TwiML)
    if (provider === 'telnyx') {
      await this.config.providers.phone.answerCall(callControlId);
    }

    console.error(`[${callId}] Incoming call from ${fromPhoneNumber}`);
    return callId;
  }

  /**
   * Start conversation for an inbound call (no greeting, immediate listening)
   */
  private async startInboundConversation(callId: string): Promise<void> {
    const state = this.activeCalls.get(callId);
    if (!state) throw new Error(`Call not found: ${callId}`);

    // Wait for WebSocket and streaming ready
    await this.waitForConnection(callId, 15000);

    // Start listening immediately (no TTS greeting)
    console.error(`[${callId}] Starting listening (inbound call)`);
    const firstTranscript = await this.listen(state);
    state.conversationHistory.push({ speaker: 'user', message: firstTranscript });

    console.error(`[${callId}] First user message: ${firstTranscript}`);
  }

  /**
   * Check if caller is allowed to make incoming calls
   */
  private isCallerAllowed(callerNumber: string): boolean {
    // By default, only the configured user can call
    const allowedCallers = process.env.CALLME_ALLOWED_CALLERS
      ? process.env.CALLME_ALLOWED_CALLERS.split(',').map(n => n.trim())
      : [this.config.userPhoneNumber];

    return allowedCallers.includes(callerNumber);
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
   * Send pre-generated mu-law audio to the call
   */
  private async sendPreGeneratedAudio(state: CallState, muLawData: Buffer): Promise<void> {
    console.error(`[${state.callId}] Sending pre-generated audio...`);
    const chunkSize = 160;  // 20ms at 8kHz
    for (let i = 0; i < muLawData.length; i += chunkSize) {
      const chunk = muLawData.subarray(i, i + chunkSize);
      if (state.ws?.readyState === WebSocket.OPEN) {
        // Send JSON-wrapped media (Twilio requires streamSid, Telnyx doesn't)
        const message: Record<string, unknown> = {
          event: 'media',
          media: { payload: chunk.toString('base64') },
        };
        if (state.streamSid) {
          message.streamSid = state.streamSid;
        }
        state.ws.send(JSON.stringify(message));
      }
      await new Promise((resolve) => setTimeout(resolve, 18));
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

        while (pendingMuLaw.length >= OUTPUT_CHUNK_SIZE) {
          const audioChunk = pendingMuLaw.subarray(0, OUTPUT_CHUNK_SIZE);
          pendingMuLaw = pendingMuLaw.subarray(OUTPUT_CHUNK_SIZE);

          if (state.ws?.readyState === WebSocket.OPEN) {
            // Send JSON-wrapped media (Twilio requires streamSid, Telnyx doesn't)
            const message: Record<string, unknown> = {
              event: 'media',
              media: { payload: audioChunk.toString('base64') },
            };
            if (state.streamSid) {
              message.streamSid = state.streamSid;
            }
            state.ws.send(JSON.stringify(message));
          }
          await new Promise((resolve) => setTimeout(resolve, 18));
        }
      }
    }

    // Send remaining audio
    if (pendingMuLaw.length > 0 && state.ws?.readyState === WebSocket.OPEN) {
      const message: Record<string, unknown> = {
        event: 'media',
        media: { payload: pendingMuLaw.toString('base64') },
      };
      if (state.streamSid) {
        message.streamSid = state.streamSid;
      }
      state.ws.send(JSON.stringify(message));
    }
  }

  private async sendAudio(state: CallState, pcmData: Buffer): Promise<void> {
    const resampledPcm = this.resample24kTo8k(pcmData);
    const muLawData = this.pcmToMuLaw(resampledPcm);

    const chunkSize = 160;
    for (let i = 0; i < muLawData.length; i += chunkSize) {
      const chunk = muLawData.subarray(i, i + chunkSize);
      if (state.ws?.readyState === WebSocket.OPEN) {
        // Send JSON-wrapped media (Twilio requires streamSid, Telnyx doesn't)
        const message: Record<string, unknown> = {
          event: 'media',
          media: { payload: chunk.toString('base64') },
        };
        if (state.streamSid) {
          message.streamSid = state.streamSid;
        }
        state.ws.send(JSON.stringify(message));
      }
      await new Promise((resolve) => setTimeout(resolve, 18));
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
      const sample = pcmData.readInt16LE(i * 3 * 2);
      output.writeInt16LE(sample, i * 2);
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

  /**
   * Get information about all active calls
   */
  getActiveCallsInfo(): Array<{
    callId: string;
    direction: 'inbound' | 'outbound';
    userPhoneNumber: string;
    startTime: string;
    durationSeconds: number;
  }> {
    const calls: Array<{
      callId: string;
      direction: 'inbound' | 'outbound';
      userPhoneNumber: string;
      startTime: string;
      durationSeconds: number;
    }> = [];

    for (const [callId, state] of this.activeCalls) {
      calls.push({
        callId,
        direction: state.direction,
        userPhoneNumber: state.userPhoneNumber,
        startTime: new Date(state.startTime).toISOString(),
        durationSeconds: Math.round((Date.now() - state.startTime) / 1000),
      });
    }

    return calls;
  }

  shutdown(): void {
    for (const callId of this.activeCalls.keys()) {
      this.endCall(callId, 'Goodbye!').catch(console.error);
    }
    this.wss?.close();
    this.httpServer?.close();
  }
}
