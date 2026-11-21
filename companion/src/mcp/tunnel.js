'use strict';
// Cloudflare Quick Tunnel manager for exposing the authenticated local /mcp server
// over a public HTTPS URL for Gemini Web Developer Mode (gemini.google.com/devmode).
// Refuses to start if the local MCP server or authentication is not active.

const { spawn } = require('child_process');

const TRY_CLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

function parseTunnelUrl(chunk) {
  const m = TRY_CLOUDFLARE_RE.exec(String(chunk || ''));
  return m ? m[0] : '';
}

function createTunnelManager({ spawnImpl = spawn, isMcpRunning = () => false, hasAuth = () => false, log = () => {} } = {}) {
  let child = null;
  let tunnelUrl = '';
  let lastError = '';
  let starting = false;

  async function start(port = 3847) {
    if (!isMcpRunning()) {
      throw new Error('Start the local MCP server before starting the Cloudflare tunnel.');
    }
    if (!hasAuth()) {
      throw new Error('Authentication (Bearer token + OAuth) must be configured before exposing a public tunnel.');
    }
    if (child && tunnelUrl) return status();

    await stop();
    starting = true;
    lastError = '';
    tunnelUrl = '';

    return new Promise((resolve, reject) => {
      let settled = false;
      const args = ['tunnel', '--url', `http://127.0.0.1:${Number(port) || 3847}`, '--no-autoupdate'];
      try {
        child = spawnImpl('cloudflared', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        starting = false;
        lastError = 'cloudflared is not installed or could not start.';
        return reject(new Error(lastError));
      }

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          starting = false;
          lastError = 'Timed out waiting for Cloudflare quick tunnel URL.';
          stop().catch(() => {});
          reject(new Error(lastError));
        }
      }, 20000);
      if (timer.unref) timer.unref();

      const onOutput = (buf) => {
        const text = String(buf || '');
        const found = parseTunnelUrl(text);
        if (found && !tunnelUrl) {
          tunnelUrl = found;
          starting = false;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            log(`[mcp-tunnel] ready at ${tunnelUrl}/mcp`);
            resolve(status());
          }
        }
      };

      if (child.stdout) child.stdout.on('data', onOutput);
      if (child.stderr) child.stderr.on('data', onOutput);

      child.on('error', (err) => {
        clearTimeout(timer);
        starting = false;
        child = null;
        lastError = err && err.code === 'ENOENT'
          ? 'cloudflared is not installed. Install it via "winget install Cloudflare.cloudflared" (Windows) or "brew install cloudflared" (macOS).'
          : String((err && err.message) || err);
        if (!settled) {
          settled = true;
          reject(new Error(lastError));
        }
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        starting = false;
        child = null;
        tunnelUrl = '';
        if (!settled) {
          settled = true;
          lastError = lastError || `cloudflared exited with code ${code}`;
          reject(new Error(lastError));
        }
      });
    });
  }

  async function stop() {
    const proc = child;
    child = null;
    tunnelUrl = '';
    starting = false;
    if (proc) {
      try { proc.kill(); } catch (_) {}
    }
    return status();
  }

  function status() {
    return {
      running: Boolean(child && tunnelUrl),
      starting,
      tunnelUrl,
      mcpUrl: tunnelUrl ? `${tunnelUrl}/mcp` : '',
      error: lastError,
    };
  }

  return { start, stop, status };
}

module.exports = { createTunnelManager, parseTunnelUrl };
