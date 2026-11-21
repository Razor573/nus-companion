'use strict';
// Vertex AI provider: Service Account JSON or Application Default Credentials (ADC),
// live model discovery, and multimodal generateContent / streamGenerateContent.
// Pure Node (uses built-in crypto + fetch/net.fetch); secrets stay encrypted in store.js.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PROJECT = 'gen-lang-client-0384437564';
const DEFAULT_LOCATION = 'global';
const DEFAULT_MODELS = {
  smart: 'gemini-4-hydrogen',
  fast: 'gemini-3.8-flash',
  light: 'gemini-3.5-flash-lite',
};
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const CLOUD_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

const tokenCache = new Map();

function defaultAdcPath(platform = process.platform, env = process.env, homedir = os.homedir()) {
  if (env.GOOGLE_APPLICATION_CREDENTIALS) return env.GOOGLE_APPLICATION_CREDENTIALS;
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(homedir, 'AppData', 'Roaming');
    return path.join(appData, 'gcloud', 'application_default_credentials.json');
  }
  return path.join(homedir, '.config', 'gcloud', 'application_default_credentials.json');
}

function parseCredentials(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  const text = String(raw).trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && (parsed.private_key || parsed.refresh_token || parsed.type)) return parsed;
  } catch (_) {
    if (fs.existsSync(text)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(text, 'utf8'));
        if (parsed && (parsed.private_key || parsed.refresh_token || parsed.type)) return parsed;
      } catch (_) {}
    }
  }
  return null;
}

function resolveCredentials({ storedJson, env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  const fromStored = parseCredentials(storedJson);
  if (fromStored) return { credentials: fromStored, source: 'stored' };
  const adcFile = defaultAdcPath(platform, env, homedir);
  if (adcFile && fs.existsSync(adcFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(adcFile, 'utf8'));
      if (parsed && (parsed.private_key || parsed.refresh_token)) {
        return { credentials: parsed, source: env.GOOGLE_APPLICATION_CREDENTIALS ? 'env' : 'adc', path: adcFile };
      }
    } catch (_) {}
  }
  return null;
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signJwtAssertion(credentials, nowSec = Math.floor(Date.now() / 1000)) {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: credentials.client_email,
    scope: CLOUD_SCOPE,
    aud: credentials.token_uri || TOKEN_URI,
    exp: nowSec + 3600,
    iat: nowSec,
  }));
  const unsigned = `${header}.${claim}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const sig = signer.sign(credentials.private_key);
  return `${unsigned}.${base64url(sig)}`;
}

async function getAccessToken(credentials, { fetchImpl = globalThis.fetch, nowMs = Date.now() } = {}) {
  if (!credentials) throw new Error('Vertex AI credentials are not configured.');
  if (credentials.access_token && (!credentials.expiry || credentials.expiry > nowMs + 60000)) {
    return credentials.access_token;
  }
  const cacheKey = crypto.createHash('sha256')
    .update(String(credentials.client_email || credentials.client_id || '') + ':' + String(credentials.private_key || credentials.refresh_token || '').slice(0, 64))
    .digest('hex');
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs + 60000) return cached.token;

  let body;
  const tokenUri = credentials.token_uri || TOKEN_URI;
  if (credentials.private_key && credentials.client_email) {
    const assertion = signJwtAssertion(credentials, Math.floor(nowMs / 1000));
    body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString();
  } else if (credentials.refresh_token && credentials.client_id && credentials.client_secret) {
    body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
      refresh_token: credentials.refresh_token,
    }).toString();
  } else {
    throw new Error('Unsupported Vertex AI credential format. Provide a service account JSON or gcloud ADC.');
  }

  const res = await fetchImpl(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok || !json || !json.access_token) {
    throw new Error(`Vertex OAuth token error (${res.status}): ${(json && (json.error_description || json.error)) || text.slice(0, 200)}`);
  }
  const expiresIn = Number(json.expires_in) || 3600;
  tokenCache.set(cacheKey, { token: json.access_token, expiresAt: nowMs + expiresIn * 1000 });
  return json.access_token;
}

function clearTokenCache() {
  tokenCache.clear();
}

function endpointHost(location = DEFAULT_LOCATION) {
  const loc = String(location || DEFAULT_LOCATION).trim() || DEFAULT_LOCATION;
  return loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`;
}

function modelResourceUrl({ project = DEFAULT_PROJECT, location = DEFAULT_LOCATION, model, action }) {
  const proj = String(project || DEFAULT_PROJECT).trim() || DEFAULT_PROJECT;
  const loc = String(location || DEFAULT_LOCATION).trim() || DEFAULT_LOCATION;
  const host = endpointHost(loc);
  const cleanModel = String(model || '').replace(/^publishers\/google\/models\//, '').trim();
  const base = `https://${host}/v1/projects/${encodeURIComponent(proj)}/locations/${encodeURIComponent(loc)}/publishers/google/models/${encodeURIComponent(cleanModel)}`;
  return action ? `${base}:${action}` : base;
}

function stripDataUrl(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/s.exec(dataUrl || '');
  return m ? { mime: m[1], b64: m[2] } : null;
}

function buildVertexPayload({ system, turns, imageDataUrl, maxTokens, json, temperature, model, assignment }) {
  const contents = (turns || []).map((t, i) => {
    const last = i === turns.length - 1;
    const parts = [{ text: t.text }];
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      if (img) parts.push({ inlineData: { mimeType: img.mime, data: img.b64 } });
    }
    return { role: t.role === 'assistant' ? 'model' : 'user', parts };
  });
  const generationConfig = {
    maxOutputTokens: Math.max(Number(maxTokens) || 0, 1024),
  };
  if (typeof temperature === 'number') generationConfig.temperature = temperature;
  if (json) generationConfig.responseMimeType = 'application/json';
  if (!assignment && /flash/i.test(String(model || ''))) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }
  const payload = { contents, generationConfig };
  if (system) payload.systemInstruction = { parts: [{ text: String(system) }] };
  return payload;
}

function extractTextFromCandidate(candidate) {
  const parts = candidate && candidate.content && candidate.content.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
}

async function fetchVertexModels({ credentials, project = DEFAULT_PROJECT, location = DEFAULT_LOCATION, fetchImpl = globalThis.fetch } = {}) {
  const token = await getAccessToken(credentials, { fetchImpl });
  const loc = String(location || DEFAULT_LOCATION).trim() || DEFAULT_LOCATION;
  const host = endpointHost(loc);
  const url = `https://${host}/v1beta1/publishers/google/models?pageSize=100`;
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) {
    throw new Error(`Vertex model list failed (${res.status}): ${(json && json.error && json.error.message) || text.slice(0, 200)}`);
  }
  const rawList = (json && (json.publisherModels || json.models)) || [];
  const models = [];
  const seen = new Set();
  for (const item of rawList) {
    const rawName = String((item && (item.name || item.modelId || item.id)) || '');
    const id = rawName.split('/').pop().trim();
    if (!id || seen.has(id)) continue;
    if (!/gemini/i.test(id)) continue;
    seen.add(id);
    models.push({
      id,
      displayName: (item && item.displayName) || id,
      version: (item && item.versionId) || '',
    });
  }
  return models;
}

async function streamVertex({ credentials, project = DEFAULT_PROJECT, location = DEFAULT_LOCATION, model, system, turns, imageDataUrl, maxTokens, onToken = () => {}, signal, json, onUsage, assignment, fetchImpl = globalThis.fetch }) {
  const token = await getAccessToken(credentials, { fetchImpl });
  const url = modelResourceUrl({ project, location, model, action: 'streamGenerateContent' }) + '?alt=sse';
  const payload = buildVertexPayload({ system, turns, imageDataUrl, maxTokens, json, model, assignment });
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = new Error(`Vertex AI error (${res.status}): ${errText.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }

  let full = '';
  let lastFinishReason = 'UNKNOWN';
  let usage = null;

  const processChunkJson = (chunk) => {
    if (!chunk || typeof chunk !== 'object') return;
    const cand = chunk.candidates && chunk.candidates[0];
    const t = extractTextFromCandidate(cand);
    if (t) { full += t; onToken(t); }
    if (cand && cand.finishReason) lastFinishReason = cand.finishReason;
    const u = chunk.usageMetadata;
    if (u && Number.isFinite(u.promptTokenCount) && Number.isFinite(u.candidatesTokenCount)) {
      usage = { input_tokens: u.promptTokenCount, output_tokens: u.candidatesTokenCount };
    }
  };

  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();
        if (!dataStr || dataStr === '[DONE]') continue;
        try { processChunkJson(JSON.parse(dataStr)); } catch (_) {}
      }
    }
    if (buf.trim().startsWith('data:')) {
      const dataStr = buf.trim().slice(5).trim();
      if (dataStr && dataStr !== '[DONE]') {
        try { processChunkJson(JSON.parse(dataStr)); } catch (_) {}
      }
    }
  } else {
    const rawText = await res.text();
    for (const line of rawText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr || dataStr === '[DONE]') continue;
      try { processChunkJson(JSON.parse(dataStr)); } catch (_) {}
    }
  }

  if (usage && onUsage) onUsage(usage);
  if (assignment && lastFinishReason && !/^(STOP|UNKNOWN)$/.test(lastFinishReason)) {
    throw new Error('incomplete model reply: ' + lastFinishReason);
  }
  return full;
}

async function completeVertex({ credentials, project = DEFAULT_PROJECT, location = DEFAULT_LOCATION, model, system, turns, imageDataUrl, maxTokens, json, onDelta, signal, fetchImpl = globalThis.fetch }) {
  if (typeof onDelta === 'function' && !json) {
    return streamVertex({ credentials, project, location, model, system, turns, imageDataUrl, maxTokens, onToken: onDelta, signal, json: false, fetchImpl });
  }
  const token = await getAccessToken(credentials, { fetchImpl });
  const url = modelResourceUrl({ project, location, model, action: 'generateContent' });
  const payload = buildVertexPayload({ system, turns, imageDataUrl, maxTokens, json, temperature: 0.2, model, assignment: false });
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal,
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Vertex AI error (${res.status}): ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const parsed = JSON.parse(text);
  const cand = parsed && parsed.candidates && parsed.candidates[0];
  return extractTextFromCandidate(cand);
}

module.exports = {
  DEFAULT_PROJECT,
  DEFAULT_LOCATION,
  DEFAULT_MODELS,
  defaultAdcPath,
  parseCredentials,
  resolveCredentials,
  signJwtAssertion,
  getAccessToken,
  clearTokenCache,
  endpointHost,
  modelResourceUrl,
  buildVertexPayload,
  fetchVertexModels,
  streamVertex,
  completeVertex,
};
