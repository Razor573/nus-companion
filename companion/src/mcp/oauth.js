'use strict';
// OAuth 2.1 + PKCE S256 + Dynamic & Manual Client Registration + Bearer Token Auth
// for the Nūs MCP Server (supports Gemini Web Developer Mode at gemini.google.com/devmode).
// Never accepts API keys or tokens in URL query parameters.

const crypto = require('crypto');

function generateToken(prefix = 'nus_mcp_') {
  return prefix + crypto.randomBytes(24).toString('hex');
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function verifyPkceS256(verifier, challenge) {
  if (!verifier || !challenge) return false;
  const computed = base64url(crypto.createHash('sha256').update(String(verifier)).digest());
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(String(challenge)));
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function createAuthManager({ getBearerToken, getManualClient } = {}) {
  const clients = new Map();
  const authCodes = new Map();
  const accessTokens = new Map();
  const refreshTokens = new Map();

  function findClient(clientId) {
    if (!clientId) return null;
    if (clients.has(clientId)) return clients.get(clientId);
    if (typeof getManualClient === 'function') {
      const manual = getManualClient();
      if (manual && manual.clientId && manual.clientId === clientId) {
        return {
          client_id: manual.clientId,
          client_secret: manual.clientSecret || '',
          redirect_uris: manual.redirectUris || [],
          client_name: 'Manual Client',
          manual: true,
        };
      }
    }
    return null;
  }

  function authenticateRequest(req) {
    const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
    if (urlObj.searchParams.has('api_key') || urlObj.searchParams.has('token') || urlObj.searchParams.has('access_token')) {
      return { ok: false, status: 400, error: 'query_token_forbidden', message: 'Tokens and API keys must not be passed in the URL.' };
    }
    const authHeader = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '').trim();
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
      return { ok: false, status: 401, error: 'missing_bearer_token' };
    }
    const token = authHeader.slice(7).trim();
    if (!token) return { ok: false, status: 401, error: 'empty_bearer_token' };

    const staticToken = typeof getBearerToken === 'function' ? getBearerToken() : '';
    if (staticToken && safeEqual(token, staticToken)) {
      return { ok: true, kind: 'bearer', clientId: 'local-bearer' };
    }

    const oauth = accessTokens.get(token);
    if (oauth && oauth.expiresAt > Date.now()) {
      return { ok: true, kind: 'oauth', clientId: oauth.client_id, scope: oauth.scope };
    }
    return { ok: false, status: 401, error: 'invalid_token' };
  }

  function protectedResourceMetadata(issuer) {
    return {
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp:tools'],
    };
  }

  function authorizationServerMetadata(issuer) {
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['mcp:tools'],
    };
  }

  function registerClient(body = {}) {
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)) : [];
    if (!redirectUris.length) {
      return { status: 400, body: { error: 'invalid_redirect_uri', error_description: 'At least one valid redirect_uri is required.' } };
    }
    const client_id = 'nus_client_' + crypto.randomBytes(12).toString('hex');
    const client_secret = 'nus_secret_' + crypto.randomBytes(24).toString('hex');
    const record = {
      client_id,
      client_secret,
      client_name: String(body.client_name || 'MCP Client').slice(0, 100),
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: body.token_endpoint_auth_method || 'client_secret_post',
    };
    clients.set(client_id, record);
    return { status: 201, body: record };
  }

  function renderAuthorizePage({ clientId, redirectUri, state, scope, codeChallenge, codeChallengeMethod }) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Authorize Nūs Companion MCP</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0d12;color:#f2f4f8;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#151923;border:1px solid #2b3244;border-radius:12px;padding:24px;max-width:420px;width:100%}
h1{font-size:18px;margin:0 0 8px}p{color:#b0b8c9;font-size:14px;line-height:1.45}
code{background:#0b0d12;padding:2px 6px;border-radius:4px;font-size:12px}
.actions{display:flex;gap:10px;margin-top:20px}
button{flex:1;padding:10px 14px;border-radius:8px;border:0;font-weight:600;cursor:pointer}
.allow{background:#4f8cff;color:#fff}.deny{background:#252b3b;color:#d6dce8}</style></head>
<body><div class="card"><h1>Allow access to Nūs Companion?</h1>
<p>Client <code>${escapeHtml(clientId)}</code> is requesting access to Nūs MCP tools (<code>${escapeHtml(scope || 'mcp:tools')}</code>) and will redirect to <code>${escapeHtml(redirectUri)}</code>.</p>
<form method="POST" action="/oauth/authorize">
<input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
<input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
<input type="hidden" name="state" value="${escapeHtml(state)}">
<input type="hidden" name="scope" value="${escapeHtml(scope)}">
<input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}">
<input type="hidden" name="code_challenge_method" value="${escapeHtml(codeChallengeMethod)}">
<div class="actions"><button class="deny" type="submit" name="decision" value="deny">Deny</button><button class="allow" type="submit" name="decision" value="allow">Approve</button></div>
</form></div></body></html>`;
  }

  function issueAuthorizationCode({ clientId, redirectUri, codeChallenge, codeChallengeMethod, scope }) {
    const client = findClient(clientId);
    if (!client) return { error: 'invalid_client', error_description: 'Unknown client_id.' };
    if (!redirectUri) return { error: 'invalid_request', error_description: 'redirect_uri is required.' };
    if (client.redirect_uris.length && !client.redirect_uris.includes(redirectUri)) {
      return { error: 'invalid_redirect_uri', error_description: 'redirect_uri does not match registered URIs.' };
    }
    if (codeChallenge && codeChallengeMethod && codeChallengeMethod !== 'S256') {
      return { error: 'invalid_request', error_description: 'Only S256 code_challenge_method is supported.' };
    }
    const code = 'nus_code_' + crypto.randomBytes(20).toString('hex');
    authCodes.set(code, {
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge || '',
      scope: scope || 'mcp:tools',
      expiresAt: Date.now() + 5 * 60 * 1000,
    });
    return { code };
  }

  function exchangeToken(params = {}, basicAuthHeader = '') {
    let clientId = params.client_id || '';
    let clientSecret = params.client_secret || '';
    if (basicAuthHeader && basicAuthHeader.toLowerCase().startsWith('basic ')) {
      try {
        const decoded = Buffer.from(basicAuthHeader.slice(6).trim(), 'base64').toString('utf8');
        const idx = decoded.indexOf(':');
        if (idx >= 0) {
          clientId = decodeURIComponent(decoded.slice(0, idx));
          clientSecret = decodeURIComponent(decoded.slice(idx + 1));
        }
      } catch (_) {}
    }

    const grantType = params.grant_type;
    if (grantType === 'authorization_code') {
      const record = authCodes.get(params.code);
      authCodes.delete(params.code);
      if (!record || record.expiresAt < Date.now()) {
        return { status: 400, body: { error: 'invalid_grant', error_description: 'Authorization code is invalid or expired.' } };
      }
      if (clientId && record.client_id !== clientId) {
        return { status: 400, body: { error: 'invalid_grant', error_description: 'client_id mismatch.' } };
      }
      if (params.redirect_uri && params.redirect_uri !== record.redirect_uri) {
        return { status: 400, body: { error: 'invalid_grant', error_description: 'redirect_uri mismatch.' } };
      }
      const client = findClient(record.client_id);
      if (client && client.client_secret && clientSecret && !safeEqual(clientSecret, client.client_secret)) {
        return { status: 401, body: { error: 'invalid_client', error_description: 'Invalid client_secret.' } };
      }
      if (record.code_challenge) {
        if (!verifyPkceS256(params.code_verifier, record.code_challenge)) {
          return { status: 400, body: { error: 'invalid_grant', error_description: 'PKCE code_verifier check failed.' } };
        }
      } else if (client && client.client_secret && !safeEqual(clientSecret, client.client_secret)) {
        return { status: 401, body: { error: 'invalid_client', error_description: 'client_secret or PKCE is required.' } };
      }

      const access_token = generateToken('nus_oauth_');
      const refresh_token = generateToken('nus_ref_');
      const expires_in = 3600;
      accessTokens.set(access_token, { client_id: record.client_id, scope: record.scope, expiresAt: Date.now() + expires_in * 1000 });
      refreshTokens.set(refresh_token, { client_id: record.client_id, scope: record.scope });
      return {
        status: 200,
        body: { access_token, token_type: 'Bearer', expires_in, refresh_token, scope: record.scope },
      };
    }

    if (grantType === 'refresh_token') {
      const ref = refreshTokens.get(params.refresh_token);
      if (!ref) return { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid refresh_token.' } };
      const access_token = generateToken('nus_oauth_');
      const expires_in = 3600;
      accessTokens.set(access_token, { client_id: ref.client_id, scope: ref.scope, expiresAt: Date.now() + expires_in * 1000 });
      return {
        status: 200,
        body: { access_token, token_type: 'Bearer', expires_in, scope: ref.scope },
      };
    }

    return { status: 400, body: { error: 'unsupported_grant_type' } };
  }

  return {
    authenticateRequest,
    protectedResourceMetadata,
    authorizationServerMetadata,
    registerClient,
    renderAuthorizePage,
    issueAuthorizationCode,
    exchangeToken,
    findClient,
  };
}

module.exports = {
  generateToken,
  verifyPkceS256,
  safeEqual,
  createAuthManager,
};
