'use strict';
// Local MCP Server over Streamable HTTP at /mcp (127.0.0.1 only by default).
// Uses the official @modelcontextprotocol/sdk when installed, with a compliant
// JSON-RPC 2.0 Streamable HTTP handler so unit tests run with zero extra setup.

const http = require('http');
const crypto = require('crypto');
const { TOOL_SPECS, createToolHandlers } = require('./tools');
const { createAuthManager } = require('./oauth');

const PROTOCOL_VERSION = '2025-03-26';

function loadMcpSdk() {
  try {
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const { z } = require('zod');
    return { McpServer, StreamableHTTPServerTransport, z };
  } catch (_) {
    return null;
  }
}

function readBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function issuerFromReq(req, port, getPublicOrigin) {
  if (typeof getPublicOrigin === 'function') {
    const pub = getPublicOrigin();
    if (pub) return pub.replace(/\/$/, '');
  }
  const host = (req.headers && req.headers.host) || `127.0.0.1:${port}`;
  const proto = (req.headers && req.headers['x-forwarded-proto']) || 'http';
  return `${proto}://${host}`;
}

function buildZodShape(inputSchema, z) {
  const props = (inputSchema && inputSchema.properties) || {};
  const required = new Set((inputSchema && inputSchema.required) || []);
  const shape = {};
  for (const [k, def] of Object.entries(props)) {
    let field;
    if (def.type === 'number') field = z.number();
    else if (def.type === 'boolean') field = z.boolean();
    else if (Array.isArray(def.enum)) field = z.enum(def.enum);
    else field = z.string();
    if (def.description) field = field.describe(def.description);
    if (!required.has(k)) field = field.optional();
    shape[k] = field;
  }
  return shape;
}

function createMcpServerManager({
  getPort = () => 3847,
  getBearerToken = () => '',
  getManualClient = () => null,
  getPublicOrigin = () => '',
  toolDeps = {},
  log = () => {},
} = {}) {
  const auth = createAuthManager({ getBearerToken, getManualClient });
  const handlers = createToolHandlers(toolDeps);
  const sdk = loadMcpSdk();
  const sessions = new Map();

  let httpServer = null;
  let running = false;
  let boundPort = null;

  async function handleJsonRpcFallback(req, res) {
    const raw = await readBody(req);
    let msg;
    try { msg = JSON.parse(raw); } catch {
      return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const id = msg && Object.prototype.hasOwnProperty.call(msg, 'id') ? msg.id : null;
    const method = msg && msg.method;
    const params = (msg && msg.params) || {};

    if (method === 'initialize') {
      const sid = crypto.randomUUID();
      sessions.set(sid, { createdAt: Date.now() });
      return sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'nus-companion', version: '0.1.30' },
        },
      }, { 'mcp-session-id': sid });
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      res.writeHead(202);
      res.end();
      return;
    }
    if (method === 'ping') {
      return sendJson(res, 200, { jsonrpc: '2.0', id, result: {} });
    }
    if (method === 'tools/list') {
      return sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: TOOL_SPECS } });
    }
    if (method === 'tools/call') {
      const name = params.name;
      const fn = handlers[name];
      if (!fn) {
        return sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unknown tool: ${name}` },
        });
      }
      try {
        const result = await fn(params.arguments || {});
        return sendJson(res, 200, { jsonrpc: '2.0', id, result });
      } catch (err) {
        return sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: String(err.message || err) }], isError: true },
        });
      }
    }
    return sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }

  async function handleWithSdk(req, res) {
    const raw = await readBody(req);
    let parsedBody;
    try { parsedBody = raw ? JSON.parse(raw) : undefined; } catch {
      return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const server = new sdk.McpServer({ name: 'nus-companion', version: '0.1.30' });
    for (const spec of TOOL_SPECS) {
      const shape = buildZodShape(spec.inputSchema, sdk.z);
      server.tool(spec.name, spec.description, shape, async (args) => handlers[spec.name](args));
    }
    const transport = new sdk.StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      try { transport.close(); } catch (_) {}
      try { server.close(); } catch (_) {}
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  }

  async function handleRequest(req, res) {
    const urlObj = new URL(req.url || '/', `http://127.0.0.1:${boundPort || getPort()}`);
    const pathname = urlObj.pathname;
    const issuer = issuerFromReq(req, boundPort || getPort(), getPublicOrigin);

    if (req.method === 'GET' && pathname === '/.well-known/oauth-protected-resource') {
      return sendJson(res, 200, auth.protectedResourceMetadata(issuer));
    }
    if (req.method === 'GET' && pathname === '/.well-known/oauth-authorization-server') {
      return sendJson(res, 200, auth.authorizationServerMetadata(issuer));
    }
    if (req.method === 'POST' && pathname === '/oauth/register') {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { error: 'invalid_request' }); }
      const reg = auth.registerClient(body);
      return sendJson(res, reg.status, reg.body);
    }
    if (req.method === 'GET' && pathname === '/oauth/authorize') {
      const html = auth.renderAuthorizePage({
        clientId: urlObj.searchParams.get('client_id') || '',
        redirectUri: urlObj.searchParams.get('redirect_uri') || '',
        state: urlObj.searchParams.get('state') || '',
        scope: urlObj.searchParams.get('scope') || 'mcp:tools',
        codeChallenge: urlObj.searchParams.get('code_challenge') || '',
        codeChallengeMethod: urlObj.searchParams.get('code_challenge_method') || 'S256',
      });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    if (req.method === 'POST' && pathname === '/oauth/authorize') {
      const raw = await readBody(req);
      const form = Object.fromEntries(new URLSearchParams(raw));
      const redirectUri = form.redirect_uri || '';
      if (form.decision !== 'allow') {
        const sep = redirectUri.includes('?') ? '&' : '?';
        res.writeHead(302, { Location: `${redirectUri}${sep}error=access_denied${form.state ? '&state=' + encodeURIComponent(form.state) : ''}` });
        res.end();
        return;
      }
      const issued = auth.issueAuthorizationCode({
        clientId: form.client_id,
        redirectUri,
        codeChallenge: form.code_challenge,
        codeChallengeMethod: form.code_challenge_method,
        scope: form.scope,
      });
      if (issued.error) return sendJson(res, 400, issued);
      const sep = redirectUri.includes('?') ? '&' : '?';
      res.writeHead(302, { Location: `${redirectUri}${sep}code=${encodeURIComponent(issued.code)}${form.state ? '&state=' + encodeURIComponent(form.state) : ''}` });
      res.end();
      return;
    }
    if (req.method === 'POST' && pathname === '/oauth/token') {
      const raw = await readBody(req);
      const ct = String((req.headers && req.headers['content-type']) || '').toLowerCase();
      let params = {};
      if (ct.includes('application/json')) {
        try { params = JSON.parse(raw || '{}'); } catch { params = {}; }
      } else {
        params = Object.fromEntries(new URLSearchParams(raw));
      }
      const tok = auth.exchangeToken(params, req.headers && req.headers.authorization);
      return sendJson(res, tok.status, tok.body);
    }

    if (pathname === '/mcp') {
      const check = auth.authenticateRequest(req);
      if (!check.ok) {
        return sendJson(res, check.status || 401, {
          error: check.error,
          error_description: check.message || 'Authentication required.',
        }, {
          'WWW-Authenticate': `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`,
        });
      }
      if (req.method === 'DELETE') {
        const sid = req.headers['mcp-session-id'];
        if (sid) sessions.delete(sid);
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method !== 'POST' && req.method !== 'GET') {
        return sendJson(res, 405, { error: 'method_not_allowed' });
      }
      if (sdk && req.method === 'POST') {
        return handleWithSdk(req, res);
      }
      if (req.method === 'POST') {
        return handleJsonRpcFallback(req, res);
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': ok\n\n');
      return;
    }

    return sendJson(res, 404, { error: 'not_found' });
  }

  async function start() {
    if (running && httpServer) return status();
    const token = typeof getBearerToken === 'function' ? getBearerToken() : '';
    if (!token) throw new Error('MCP Bearer token must be configured before starting the MCP server.');
    const port = Number(getPort()) || 3847;
    httpServer = http.createServer((req, res) => {
      handleRequest(req, res).catch((err) => {
        log('[mcp] request error: ' + (err && err.message ? err.message : String(err)));
        if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      });
    });
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, '127.0.0.1', () => {
        httpServer.removeListener('error', reject);
        resolve();
      });
    });
    const addr = httpServer.address();
    boundPort = addr && typeof addr === 'object' ? addr.port : port;
    running = true;
    log(`[mcp] listening on http://127.0.0.1:${boundPort}/mcp`);
    return status();
  }

  async function stop() {
    if (!httpServer) {
      running = false;
      boundPort = null;
      return status();
    }
    const srv = httpServer;
    httpServer = null;
    running = false;
    boundPort = null;
    sessions.clear();
    await new Promise((resolve) => srv.close(() => resolve()));
    log('[mcp] stopped');
    return status();
  }

  function status() {
    return {
      running,
      host: '127.0.0.1',
      port: boundPort || Number(getPort()) || 3847,
      url: running ? `http://127.0.0.1:${boundPort}/mcp` : '',
      sdkLoaded: !!sdk,
      tools: TOOL_SPECS.map((t) => t.name),
    };
  }

  return { start, stop, status, auth, handlers, handleRequest };
}

module.exports = { createMcpServerManager, PROTOCOL_VERSION };
