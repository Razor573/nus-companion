'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const EventEmitter = require('events');
const { PassThrough } = require('stream');

const { createMcpServerManager } = require('../src/mcp/server');
const { createTunnelManager, parseTunnelUrl } = require('../src/mcp/tunnel');
const { createStdioBridge } = require('../src/mcp/stdio');
const { TOOL_SPECS } = require('../src/mcp/tools');

function pkcePair() {
  const verifier = 'test-verifier-' + crypto.randomBytes(16).toString('hex');
  const challenge = Buffer.from(crypto.createHash('sha256').update(verifier).digest())
    .toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return { verifier, challenge };
}

test('MCP server exposes all 9 required tools, enforces Bearer auth, and rejects URL query tokens', async () => {
  const calls = [];
  const mgr = createMcpServerManager({
    getPort: () => 0,
    getBearerToken: () => 'nus_mcp_secret_token_123',
    toolDeps: {
      screenshot: async () => ({ dataUrl: 'data:image/jpeg;base64,AAAA', pxWidth: 1920, pxHeight: 1080 }),
      getScreenState: async () => ({ window: { title: 'Notepad', process: 'notepad' }, elements: [{ id: 1, name: 'Save' }] }),
      pointAtElement: async (a) => { calls.push(['point', a]); return { ok: true }; },
      click: async (a) => { calls.push(['click', a]); return { ok: true }; },
      type: async (a) => { calls.push(['type', a]); return { ok: true }; },
      pressKey: async (a) => { calls.push(['press_key', a]); return { ok: true }; },
      scroll: async (a) => { calls.push(['scroll', a]); return { ok: true }; },
      launchApp: async (a) => { calls.push(['launch_app', a]); return { ok: true }; },
      runRoutine: async (a) => { calls.push(['run_routine', a]); return { ok: true, steps: 2 }; },
    },
  });

  const st = await mgr.start();
  assert.equal(st.running, true);
  assert.equal(st.host, '127.0.0.1');
  assert.deepEqual(
    TOOL_SPECS.map((t) => t.name),
    ['screenshot', 'get_screen_state', 'point_at_element', 'click', 'type', 'press_key', 'scroll', 'launch_app', 'run_routine']
  );

  try {
    const unauth = await fetch(st.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(unauth.status, 401);
    assert.ok(unauth.headers.get('www-authenticate').includes('oauth-protected-resource'));

    const urlKey = await fetch(st.url + '?api_key=nus_mcp_secret_token_123', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nus_mcp_secret_token_123' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(urlKey.status, 400);

    const listRes = await fetch(st.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nus_mcp_secret_token_123' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json();
    assert.equal(listJson.result.tools.length, 9);

    const callTool = async (id, name, args) => {
      const r = await fetch(st.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nus_mcp_secret_token_123' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
      });
      return r.json();
    };

    const shot = await callTool(3, 'screenshot', {});
    assert.equal(shot.result.content[0].type, 'image');
    assert.equal(shot.result.content[0].data, 'AAAA');

    const screenState = await callTool(4, 'get_screen_state', {});
    assert.ok(screenState.result.content[0].text.includes('Notepad'));

    await callTool(5, 'point_at_element', { text: 'Save' });
    await callTool(6, 'click', { id: 1 });
    await callTool(7, 'type', { text: 'hello' });
    await callTool(8, 'press_key', { keys: 'ctrl+s' });
    await callTool(9, 'scroll', { direction: 'down', amount: 2 });
    await callTool(10, 'launch_app', { app: 'Notepad' });
    await callTool(11, 'run_routine', { name: 'morning' });

    assert.equal(calls.length, 7);
    assert.equal(calls[6][0], 'run_routine');
  } finally {
    await mgr.stop();
  }
});

test('MCP OAuth 2.1 supports Dynamic Client Registration, PKCE S256, and /mcp access', async () => {
  const mgr = createMcpServerManager({
    getPort: () => 0,
    getBearerToken: () => 'nus_mcp_static_token',
    getPublicOrigin: () => 'https://example-tunnel.trycloudflare.com',
  });
  const st = await mgr.start();
  const base = `http://127.0.0.1:${st.port}`;

  try {
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    assert.equal(prm.resource, 'https://example-tunnel.trycloudflare.com/mcp');

    const asm = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.equal(asm.registration_endpoint, 'https://example-tunnel.trycloudflare.com/oauth/register');

    const regRes = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Gemini DevMode', redirect_uris: ['https://gemini.google.com/callback'] }),
    });
    assert.equal(regRes.status, 201);
    const client = await regRes.json();

    const { verifier, challenge } = pkcePair();
    const authRes = await fetch(`${base}/oauth/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: 'https://gemini.google.com/callback',
        state: 'st123',
        scope: 'mcp:tools',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        decision: 'allow',
      }).toString(),
    });
    assert.equal(authRes.status, 302);
    const loc = new URL(authRes.headers.get('location'));
    const code = loc.searchParams.get('code');
    assert.ok(code);

    const tokRes = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://gemini.google.com/callback',
        client_id: client.client_id,
        client_secret: client.client_secret,
        code_verifier: verifier,
      }).toString(),
    });
    assert.equal(tokRes.status, 200);
    const tok = await tokRes.json();
    assert.ok(tok.access_token.startsWith('nus_oauth_'));

    const mcpRes = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(mcpRes.status, 200);
  } finally {
    await mgr.stop();
  }
});

test('Cloudflare quick tunnel requires MCP + auth and parses trycloudflare HTTPS URL', async () => {
  const blocked = createTunnelManager({ isMcpRunning: () => false, hasAuth: () => true });
  await assert.rejects(() => blocked.start(3847), /Start the local MCP server/);

  const noAuth = createTunnelManager({ isMcpRunning: () => true, hasAuth: () => false });
  await assert.rejects(() => noAuth.start(3847), /Authentication/);

  const fakeProc = new EventEmitter();
  fakeProc.stdout = new PassThrough();
  fakeProc.stderr = new PassThrough();
  fakeProc.kill = () => { fakeProc.emit('close', 0); };

  const tunnel = createTunnelManager({
    isMcpRunning: () => true,
    hasAuth: () => true,
    spawnImpl: () => {
      setTimeout(() => {
        fakeProc.stderr.write('INF |  https://bright-otter-1234.trycloudflare.com  |\n');
      }, 10);
      return fakeProc;
    },
  });

  const st = await tunnel.start(3847);
  assert.equal(st.running, true);
  assert.equal(st.tunnelUrl, 'https://bright-otter-1234.trycloudflare.com');
  assert.equal(st.mcpUrl, 'https://bright-otter-1234.trycloudflare.com/mcp');
  assert.equal(parseTunnelUrl('Visit https://abc-xyz.trycloudflare.com now'), 'https://abc-xyz.trycloudflare.com');
  await tunnel.stop();
});

test('Local MCP stdio bridge forwards JSON-RPC lines with Bearer token', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const seen = [];
  const rl = createStdioBridge({
    mcpUrl: 'http://127.0.0.1:3847/mcp',
    token: 'nus_mcp_stdio_tok',
    input,
    output,
    fetchImpl: async (url, opts) => {
      seen.push({ url, auth: opts.headers.Authorization, body: JSON.parse(opts.body) });
      return {
        status: 200,
        headers: { get: () => 'sid-1' },
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }),
      };
    },
  });

  const outPromise = new Promise((resolve) => {
    output.once('data', (chunk) => resolve(chunk.toString('utf8').trim()));
  });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
  const line = await outPromise;
  rl.close();

  assert.equal(seen[0].auth, 'Bearer nus_mcp_stdio_tok');
  assert.deepEqual(JSON.parse(line), { jsonrpc: '2.0', id: 1, result: { ok: true } });
});
