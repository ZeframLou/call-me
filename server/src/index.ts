#!/usr/bin/env bun

/**
 * CallMe MCP Server
 *
 * A stdio-based MCP server that lets Claude call you on the phone.
 * Automatically starts ngrok to expose webhooks for phone providers.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CallManager, loadServerConfig, type DiagnosticsInfo } from './phone-call.js';
import { startNgrok, stopNgrok } from './ngrok.js';

/**
 * Format diagnostics into human-readable output for Claude
 */
function formatDiagnostics(d: DiagnosticsInfo): string {
  const lines: string[] = [];

  lines.push('## CallMe Server Diagnostics\n');

  // Server status
  lines.push(`**Server Status:** ${d.serverStatus}`);
  lines.push(`**Uptime:** ${d.uptime}s`);
  lines.push(`**ngrok URL:** ${d.ngrokUrl}`);
  lines.push(`**ngrok Status:** ${d.ngrokStatus}`);
  lines.push(`**Active Calls:** ${d.activeCalls}\n`);

  // Configuration
  lines.push('### Configuration');
  lines.push(`- Phone Provider: ${d.config.phoneProvider}`);
  lines.push(`- Phone Number: ${d.config.phoneNumber}`);
  lines.push(`- User Phone: ${d.config.userPhoneNumber}`);
  lines.push(`- Connection Timeout: ${d.config.connectionTimeoutMs}ms`);
  lines.push(`- Max Retries: ${d.config.maxCallRetries}\n`);

  // Active calls
  if (d.activeCallDetails.length > 0) {
    lines.push('### Active Calls');
    for (const call of d.activeCallDetails) {
      lines.push(`- **${call.callId}**: ${call.state} (${call.durationSecs}s) - WS: ${call.wsConnected ? '✓' : '✗'}, Stream: ${call.streamReady ? '✓' : '✗'}`);
    }
    lines.push('');
  }

  // Recent events
  if (d.recentEvents.length > 0) {
    lines.push('### Recent Events (last 20)');
    for (const event of d.recentEvents.slice().reverse()) {
      const time = new Date(event.timestamp).toISOString().slice(11, 19);
      const callInfo = event.callId ? ` [${event.callId}]` : '';
      lines.push(`- ${time}${callInfo} **${event.type}**: ${event.message}`);
    }
  } else {
    lines.push('### Recent Events');
    lines.push('No events recorded yet.');
  }

  return lines.join('\n');
}
import { ensureKokoroRunning } from './providers/tts-kokoro.js';
import { loadProviderConfig } from './providers/index.js';

async function main() {
  // Get port for HTTP server (default 0 = ephemeral, OS picks free port)
  const port = parseInt(process.env.CALLME_PORT || '0', 10);

  // Auto-setup Kokoro Docker container if needed (before config validation)
  const providerConfig = loadProviderConfig();
  if (providerConfig.ttsProvider === 'kokoro' && !providerConfig.kokoroUrl) {
    try {
      const kokoroBaseUrl = await ensureKokoroRunning();
      process.env.CALLME_KOKORO_URL = `${kokoroBaseUrl}/v1`;
    } catch (error) {
      console.error('Kokoro setup failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  }

  // Load server config (validates env vars, no network needed)
  let serverConfig;
  try {
    serverConfig = loadServerConfig('');
  } catch (error) {
    console.error('Configuration error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // Create call manager and bind HTTP server FIRST (before ngrok)
  const callManager = new CallManager(serverConfig);
  let actualPort: number;
  try {
    actualPort = await callManager.startServer();
  } catch (error) {
    console.error('Failed to start HTTP server:', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // Start ngrok tunnel pointing at the actual bound port
  console.error('Starting ngrok tunnel...');
  let publicUrl: string;
  try {
    publicUrl = await startNgrok(actualPort, (newUrl) => {
      console.error(`[ngrok] Updating public URL to: ${newUrl}`);
      callManager.setPublicUrl(newUrl);
    });
    callManager.setPublicUrl(publicUrl);
    console.error(`ngrok tunnel: ${publicUrl}`);
  } catch (error) {
    console.error('Failed to start ngrok:', error instanceof Error ? error.message : error);
    await callManager.shutdown();
    process.exit(1);
  }

  // Create stdio MCP server
  const mcpServer = new Server(
    { name: 'callme', version: '3.0.0' },
    { capabilities: { tools: {} } }
  );

  // List available tools
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'initiate_call',
          description: 'Start a phone call with the user. Use when you need voice input, want to report completed work, or need real-time discussion.',
          inputSchema: {
            type: 'object',
            properties: {
              message: {
                type: 'string',
                description: 'What you want to say to the user. Be natural and conversational.',
              },
            },
            required: ['message'],
          },
        },
        {
          name: 'continue_call',
          description: 'Continue an active call with a follow-up message.',
          inputSchema: {
            type: 'object',
            properties: {
              call_id: { type: 'string', description: 'The call ID from initiate_call' },
              message: { type: 'string', description: 'Your follow-up message' },
            },
            required: ['call_id', 'message'],
          },
        },
        {
          name: 'speak_to_user',
          description: 'Speak a message on an active call without waiting for a response. Use this to acknowledge requests or provide status updates before starting time-consuming operations.',
          inputSchema: {
            type: 'object',
            properties: {
              call_id: { type: 'string', description: 'The call ID from initiate_call' },
              message: { type: 'string', description: 'What to say to the user' },
            },
            required: ['call_id', 'message'],
          },
        },
        {
          name: 'end_call',
          description: 'End an active call with a closing message.',
          inputSchema: {
            type: 'object',
            properties: {
              call_id: { type: 'string', description: 'The call ID from initiate_call' },
              message: { type: 'string', description: 'Your closing message (say goodbye!)' },
            },
            required: ['call_id', 'message'],
          },
        },
        {
          name: 'get_diagnostics',
          description: 'Get diagnostic information about the callme server. Use this to troubleshoot issues, check server health, view recent events, and inspect active calls. Returns server status, ngrok tunnel info, configuration, and recent call history.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
      ],
    };
  });

  // Handle tool calls
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      if (request.params.name === 'initiate_call') {
        const { message } = request.params.arguments as { message: string };
        const result = await callManager.initiateCall(message);

        return {
          content: [{
            type: 'text',
            text: `Call initiated successfully.\n\nCall ID: ${result.callId}\n\nUser's response:\n${result.response}\n\nUse continue_call to ask follow-ups or end_call to hang up.`,
          }],
        };
      }

      if (request.params.name === 'continue_call') {
        const { call_id, message } = request.params.arguments as { call_id: string; message: string };
        const response = await callManager.continueCall(call_id, message);

        return {
          content: [{ type: 'text', text: `User's response:\n${response}` }],
        };
      }

      if (request.params.name === 'speak_to_user') {
        const { call_id, message } = request.params.arguments as { call_id: string; message: string };
        await callManager.speakOnly(call_id, message);

        return {
          content: [{ type: 'text', text: `Message spoken: "${message}"` }],
        };
      }

      if (request.params.name === 'end_call') {
        const { call_id, message } = request.params.arguments as { call_id: string; message: string };
        const { durationSeconds } = await callManager.endCall(call_id, message);

        return {
          content: [{ type: 'text', text: `Call ended. Duration: ${durationSeconds}s` }],
        };
      }

      if (request.params.name === 'get_diagnostics') {
        const diagnostics = callManager.getDiagnostics();
        const formattedOutput = formatDiagnostics(diagnostics);

        return {
          content: [{ type: 'text', text: formattedOutput }],
        };
      }

      throw new Error(`Unknown tool: ${request.params.name}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error: ${errorMessage}` }],
        isError: true,
      };
    }
  });

  // Connect MCP server via stdio
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  console.error('');
  console.error('CallMe MCP server ready');
  console.error(`Phone: ${serverConfig.phoneNumber} -> ${serverConfig.userPhoneNumber}`);
  console.error(`Providers: phone=${serverConfig.providers.phone.name}, tts=${serverConfig.providers.tts.name}, stt=${serverConfig.providers.stt.name}`);
  console.error('');

  // Idempotent graceful shutdown
  let shutdownPromise: Promise<void> | null = null;
  const shutdownOnce = (reason: string, exitCode = 0): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        console.error(`\nShutting down (${reason})...`);
        await callManager.shutdown();
        await stopNgrok();
        process.exit(exitCode);
      })();
    }
    return shutdownPromise;
  };

  process.on('SIGINT', () => shutdownOnce('SIGINT'));
  process.on('SIGTERM', () => shutdownOnce('SIGTERM'));
  process.on('SIGHUP', () => shutdownOnce('SIGHUP'));
  process.stdin.on('close', () => shutdownOnce('stdin closed'));
  process.stdin.on('end', () => shutdownOnce('stdin ended'));
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    shutdownOnce('uncaughtException', 1);
  });
  process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
    shutdownOnce('unhandledRejection', 1);
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
