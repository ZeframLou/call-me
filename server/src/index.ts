#!/usr/bin/env bun

/**
 * CallMe MCP Server
 *
 * A stdio-based MCP server that lets Claude call you on the phone.
 * Automatically starts a tunnel to expose webhooks for phone providers.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CallManager, loadServerConfig } from './phone-call.js';
import { loadTunnelConfig, createTunnelProvider, validateTunnelConfig, type TunnelProvider } from './tunnels/index.js';

async function main() {
  // Create stdio MCP server FIRST so Claude Code gets the handshake quickly
  const mcpServer = new Server(
    { name: 'callme', version: '3.0.0' },
    { capabilities: { tools: {} } }
  );

  // Variables for deferred initialization
  let callManager: CallManager | null = null;
  let tunnelProvider: TunnelProvider | null = null;
  let initError: string | null = null;
  let isReady = false;

  // Start async initialization in background
  const initPromise = (async () => {
    // Get port for HTTP server
    const port = parseInt(process.env.CALLME_PORT || '3333', 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port: ${process.env.CALLME_PORT}. Must be a number between 1 and 65535.`);
    }

    // Load and validate tunnel configuration
    const tunnelConfig = loadTunnelConfig();
    const configErrors = validateTunnelConfig(tunnelConfig);
    if (configErrors.length > 0) {
      throw new Error('Tunnel configuration error:\n  ' + configErrors.join('\n  '));
    }

    // Create and start tunnel
    tunnelProvider = createTunnelProvider(tunnelConfig);
    console.error(`Starting ${tunnelProvider.name} tunnel...`);
    let publicUrl: string;
    try {
      publicUrl = await tunnelProvider.start(port);
      console.error(`${tunnelProvider.name} tunnel: ${publicUrl}`);
    } catch (error) {
      throw new Error(`Failed to start ${tunnelProvider.name}: ${error instanceof Error ? error.message : error}`);
    }

    // Load server config with the tunnel URL
    const serverConfig = loadServerConfig(publicUrl);

    // Create call manager and start HTTP server for webhooks
    callManager = new CallManager(serverConfig);
    callManager.startServer();

    console.error('');
    console.error('CallMe MCP server ready');
    console.error(`Phone: ${serverConfig.phoneNumber} -> ${serverConfig.userPhoneNumber}`);
    console.error(`Providers: phone=${serverConfig.providers.phone.name}, tts=${serverConfig.providers.tts.name}, stt=${serverConfig.providers.stt.name}`);
    console.error('');

    isReady = true;
  })();

  // Handle init errors (log but don't crash - tools will report the error)
  initPromise.catch((error) => {
    initError = error instanceof Error ? error.message : String(error);
    console.error('Initialization error:', initError);
  });

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
      ],
    };
  });

  // Handle tool calls
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    // Wait for initialization (with timeout)
    if (!isReady && !initError) {
      const timeout = 30000; // 30 second timeout for init
      const start = Date.now();
      while (!isReady && !initError && Date.now() - start < timeout) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // Check for initialization errors
    if (initError) {
      return {
        content: [{ type: 'text', text: `Server initialization failed: ${initError}` }],
        isError: true,
      };
    }

    if (!callManager) {
      return {
        content: [{ type: 'text', text: 'Server not ready yet. Please try again in a moment.' }],
        isError: true,
      };
    }

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

  // Graceful shutdown with guard to prevent double-execution
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.error('\nShutting down...');
    if (callManager) {
      callManager.shutdown();
    }
    if (tunnelProvider) {
      await tunnelProvider.stop();
    }
    process.exit(0);
  };

  // Handle stdin close (parent process exited)
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);

  // Handle termination signals
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
