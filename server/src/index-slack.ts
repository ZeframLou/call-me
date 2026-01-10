#!/usr/bin/env bun

/**
 * CallMe Slack MCP Server
 *
 * A stdio-based MCP server that lets Claude message you via Slack DMs.
 * Uses Socket Mode for real-time messaging - no ngrok or webhooks required.
 *
 * This is a free alternative to phone calls for text-based communication.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SlackChatManager, loadSlackServerConfig } from './slack-chat.js';

async function main() {
  // Load Slack configuration
  let serverConfig;
  try {
    serverConfig = loadSlackServerConfig();
  } catch (error) {
    console.error('Configuration error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // Create chat manager and start Socket Mode
  const chatManager = new SlackChatManager(serverConfig);

  console.error('Starting Slack Socket Mode connection...');
  try {
    await chatManager.start();
    console.error('Slack Socket Mode connected');
  } catch (error) {
    console.error('Failed to connect to Slack:', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // Create stdio MCP server
  const mcpServer = new Server(
    { name: 'callme-slack', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // List available tools
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'send_message',
          description: 'Send a message to the user via Slack DM and wait for their response. Use when you need text input, want to report completed work, or need discussion.',
          inputSchema: {
            type: 'object',
            properties: {
              message: {
                type: 'string',
                description: 'What you want to say to the user. Supports Slack markdown formatting.',
              },
            },
            required: ['message'],
          },
        },
        {
          name: 'continue_chat',
          description: 'Continue an active Slack conversation with a follow-up message.',
          inputSchema: {
            type: 'object',
            properties: {
              chat_id: { type: 'string', description: 'The chat ID from send_message' },
              message: { type: 'string', description: 'Your follow-up message' },
            },
            required: ['chat_id', 'message'],
          },
        },
        {
          name: 'notify_user',
          description: 'Send a one-way notification without waiting for response. Use for status updates or acknowledgments before long operations.',
          inputSchema: {
            type: 'object',
            properties: {
              chat_id: { type: 'string', description: 'The chat ID from send_message' },
              message: { type: 'string', description: 'What to say to the user' },
            },
            required: ['chat_id', 'message'],
          },
        },
        {
          name: 'end_chat',
          description: 'End an active Slack conversation with a closing message.',
          inputSchema: {
            type: 'object',
            properties: {
              chat_id: { type: 'string', description: 'The chat ID from send_message' },
              message: { type: 'string', description: 'Your closing message' },
            },
            required: ['chat_id', 'message'],
          },
        },
      ],
    };
  });

  // Handle tool calls
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      if (request.params.name === 'send_message') {
        const { message } = request.params.arguments as { message: string };
        const result = await chatManager.sendMessage(message);

        return {
          content: [{
            type: 'text',
            text: `Message sent via Slack.\n\nChat ID: ${result.chatId}\n\nUser's response:\n${result.response}\n\nUse continue_chat to ask follow-ups or end_chat to close the conversation.`,
          }],
        };
      }

      if (request.params.name === 'continue_chat') {
        const { chat_id, message } = request.params.arguments as { chat_id: string; message: string };
        const response = await chatManager.continueChat(chat_id, message);

        return {
          content: [{ type: 'text', text: `User's response:\n${response}` }],
        };
      }

      if (request.params.name === 'notify_user') {
        const { chat_id, message } = request.params.arguments as { chat_id: string; message: string };
        await chatManager.notifyUser(chat_id, message);

        return {
          content: [{ type: 'text', text: `Message sent: "${message}"` }],
        };
      }

      if (request.params.name === 'end_chat') {
        const { chat_id, message } = request.params.arguments as { chat_id: string; message: string };
        const { durationSeconds } = await chatManager.endChat(chat_id, message);

        return {
          content: [{ type: 'text', text: `Chat ended. Duration: ${durationSeconds}s` }],
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
  console.error('CallMe Slack MCP server ready');
  console.error(`Slack User: ${serverConfig.config.userSlackId}`);
  console.error('');

  // Graceful shutdown
  const shutdown = async () => {
    console.error('\nShutting down...');
    chatManager.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
