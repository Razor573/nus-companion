#!/usr/bin/env node
'use strict';
// Local MCP stdio bridge for Gemini Desktop.
// Reads newline-delimited JSON-RPC 2.0 requests from stdin and forwards them
// to the running local Nūs Companion MCP server (http://127.0.0.1:<port>/mcp)
// using the Bearer token from NUS_MCP_TOKEN.

const readline = require('readline');

function createStdioBridge({
  mcpUrl = process.env.NUS_MCP_URL || 'http://127.0.0.1:3847/mcp',
  token = process.env.NUS_MCP_TOKEN || '',
  fetchImpl = globalThis.fetch,
  input = process.stdin,
  output = process.stdout,
} = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let sessionId = '';

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch {
      output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    try {
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (sessionId) headers['mcp-session-id'] = sessionId;

      const res = await fetchImpl(mcpUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(msg),
      });
      const sid = res.headers && typeof res.headers.get === 'function' ? res.headers.get('mcp-session-id') : '';
      if (sid) sessionId = sid;

      if (res.status === 202 || res.status === 204) return;
      const text = await res.text();
      if (text.trim()) output.write(text.trim() + '\n');
    } catch (err) {
      if (Object.prototype.hasOwnProperty.call(msg, 'id')) {
        output.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: String((err && err.message) || err) },
        }) + '\n');
      }
    }
  });

  return rl;
}

if (require.main === module) {
  createStdioBridge();
}

module.exports = { createStdioBridge };
