/**
 * ngrok tunnel management for exposing local webhooks to phone providers
 */

import ngrok from '@ngrok/ngrok';

let listener: ngrok.Listener | null = null;
let currentPort: number | null = null;
let currentUrl: string | null = null;
let intentionallyClosed = false;
let reconnectAttempts = 0;
const maxReconnectAttempts = 10;
const baseReconnectDelayMs = 2000;

/**
 * Start ngrok tunnel to expose local port
 * @param port Local port to expose
 * @returns Public ngrok URL
 */
export async function startNgrok(port: number): Promise<string> {
  intentionallyClosed = false;
  reconnectAttempts = 0;
  currentPort = port;
  return doStartNgrok(port);
}

async function doStartNgrok(port: number): Promise<string> {
  const authtoken = process.env.CALLME_NGROK_AUTHTOKEN;

  if (!authtoken) {
    throw new Error(
      'CALLME_NGROK_AUTHTOKEN is required.\n' +
      'Get a free auth token at https://dashboard.ngrok.com/get-started/your-authtoken'
    );
  }

  // Enable pooling to allow multiple Claude instances to share the same endpoint
  // This load-balances requests across instances with the same domain
  // Can be disabled via CALLME_NGROK_POOLING=false if needed
  const poolingEnabled = process.env.CALLME_NGROK_POOLING !== 'false';

  listener = await ngrok.forward({
    addr: port,
    authtoken,
    // Use custom domain if configured (paid ngrok feature)
    domain: process.env.CALLME_NGROK_DOMAIN || undefined,
    // Enable pooling for multi-instance support
    poolingEnabled,
  });

  const url = listener.url();
  if (!url) {
    throw new Error('Failed to get ngrok URL');
  }

  currentUrl = url;
  reconnectAttempts = 0;  // Reset on success
  console.error(`[ngrok] Tunnel established: ${url}`);

  // Monitor for disconnection
  monitorTunnel();

  return url;
}

/**
 * Monitor tunnel health and reconnect if needed
 */
async function monitorTunnel(): Promise<void> {
  // Check tunnel health periodically
  const checkInterval = setInterval(async () => {
    if (intentionallyClosed) {
      clearInterval(checkInterval);
      return;
    }

    // Check if listener is still valid
    if (!listener || !currentUrl) {
      clearInterval(checkInterval);
      console.error('[ngrok] Tunnel lost, attempting reconnect...');
      attemptReconnect();
      return;
    }

    // Actually verify the tunnel works by hitting the health endpoint
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(`${currentUrl}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`Health check returned ${response.status}`);
      }
    } catch (error) {
      clearInterval(checkInterval);
      console.error('[ngrok] Tunnel health check failed:', error);
      attemptReconnect();
    }
  }, 30000);  // Check every 30 seconds
}

/**
 * Attempt to reconnect the ngrok tunnel
 */
async function attemptReconnect(): Promise<void> {
  if (intentionallyClosed || currentPort === null) {
    return;
  }

  if (reconnectAttempts >= maxReconnectAttempts) {
    console.error(`[ngrok] Max reconnect attempts (${maxReconnectAttempts}) reached, giving up`);
    return;
  }

  reconnectAttempts++;
  const delay = baseReconnectDelayMs * Math.pow(2, reconnectAttempts - 1);
  console.error(`[ngrok] Reconnect attempt ${reconnectAttempts}/${maxReconnectAttempts} in ${delay}ms...`);

  await new Promise(resolve => setTimeout(resolve, delay));

  if (intentionallyClosed) {
    console.error('[ngrok] Reconnect cancelled - tunnel intentionally closed');
    return;
  }

  try {
    // Clean up old listener
    if (listener) {
      try {
        await listener.close();
      } catch (e) {
        // Ignore close errors
      }
      listener = null;
    }

    const newUrl = await doStartNgrok(currentPort);
    console.error(`[ngrok] Reconnected successfully: ${newUrl}`);

    // Note: The URL may have changed. For custom domains it stays the same,
    // but for free ngrok the URL changes on each reconnect.
    if (newUrl !== currentUrl) {
      console.error(`[ngrok] WARNING: Tunnel URL changed from ${currentUrl} to ${newUrl}`);
      console.error('[ngrok] Phone provider webhooks may need to be updated');
    }
  } catch (error) {
    console.error('[ngrok] Reconnect failed:', error);
    // Try again
    attemptReconnect();
  }
}

/**
 * Get the current ngrok URL
 */
export function getNgrokUrl(): string | null {
  return currentUrl;
}

/**
 * Check if ngrok tunnel is active
 */
export function isNgrokConnected(): boolean {
  return listener !== null && !intentionallyClosed;
}

/**
 * Stop ngrok tunnel
 */
export async function stopNgrok(): Promise<void> {
  intentionallyClosed = true;
  if (listener) {
    await listener.close();
    listener = null;
  }
  currentUrl = null;
}
