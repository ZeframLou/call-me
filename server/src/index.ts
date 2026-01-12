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
import { CallManager, loadServerConfig } from './phone-call.js';
import { startNgrok, stopNgrok } from './ngrok.js';

async function main() {
  // Get port for HTTP server
  const port = parseInt(process.env.CALLME_PORT || '3333', 10);

  // Start ngrok tunnel to get public URL
  console.error('Starting ngrok tunnel...');
  let publicUrl: string;
  try {
    publicUrl = await startNgrok(port);
    console.error(`ngrok tunnel: ${publicUrl}`);
  } catch (error) {
    console.error('Failed to start ngrok:', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // Load server config with the ngrok URL
  let serverConfig;
  try {
    serverConfig = loadServerConfig(publicUrl);
  } catch (error) {
    console.error('Configuration error:', error instanceof Error ? error.message : error);
    await stopNgrok();
    process.exit(1);
  }

  // Create call manager and start HTTP server for webhooks
  const callManager = new CallManager(serverConfig);
  callManager.startServer();

  // Auto-configure Twilio SMS webhook to point to ngrok URL
  if (serverConfig.providers.phone.configureSmsWebhook) {
    try {
      await serverConfig.providers.phone.configureSmsWebhook(
        serverConfig.phoneNumber,
        `${publicUrl}/sms`
      );
    } catch (error) {
      console.error('Warning: Failed to configure SMS webhook:', error instanceof Error ? error.message : error);
      console.error('Inbound SMS will not work until manually configured.');
    }
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
          name: 'check_messages',
          description: 'Check for SMS messages from the user. Use this to see if the user replied to a previous SMS or voicemail fallback. Returns any pending messages and clears the queue.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'send_sms',
          description: 'Send an SMS text message to the user. Use this for async communication when a phone call is not needed.',
          inputSchema: {
            type: 'object',
            properties: {
              message: { type: 'string', description: 'The text message to send' },
            },
            required: ['message'],
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

      if (request.params.name === 'check_messages') {
        const messages = callManager.getMessages();

        if (messages.length === 0) {
          return {
            content: [{ type: 'text', text: 'No pending messages.' }],
          };
        }

        const formatted = messages.map(m => {
          const time = new Date(m.timestamp).toLocaleTimeString();
          return `[${time}] ${m.from}: ${m.body}`;
        }).join('\n');

        return {
          content: [{ type: 'text', text: `${messages.length} message(s) received:\n\n${formatted}` }],
        };
      }

      if (request.params.name === 'send_sms') {
        const { message } = request.params.arguments as { message: string };
        await callManager.sendSms(message);

        return {
          content: [{ type: 'text', text: `SMS sent: "${message}"` }],
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

  // Graceful shutdown
  const shutdown = async () => {
    console.error('\nShutting down...');
    callManager.shutdown();
    await stopNgrok();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
