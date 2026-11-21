'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const vertex = require('../src/vertex');
const { createLLM } = require('../src/llm');

function makeEphemeralSa() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    type: 'service_account',
    project_id: 'gen-lang-client-0384437564',
    private_key_id: 'test-key-id',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    client_email: 'nus-test@gen-lang-client-0384437564.iam.gserviceaccount.com',
    token_uri: 'https://oauth2.googleapis.com/token',
  };
}

test('vertex defaults use project gen-lang-client-0384437564 and Gemini 4 Hydrogen / 3.8 Flash / 3.5 Flash-Lite', () => {
  assert.equal(vertex.DEFAULT_PROJECT, 'gen-lang-client-0384437564');
  assert.equal(vertex.DEFAULT_LOCATION, 'global');
  assert.equal(vertex.DEFAULT_MODELS.smart, 'gemini-4-hydrogen');
  assert.equal(vertex.DEFAULT_MODELS.fast, 'gemini-3.8-flash');
  assert.equal(vertex.DEFAULT_MODELS.light, 'gemini-3.5-flash-lite');
});

test('vertex resolves credentials from stored JSON or ADC file', () => {
  const sa = makeEphemeralSa();
  const fromStored = vertex.resolveCredentials({ storedJson: JSON.stringify(sa) });
  assert.equal(fromStored.source, 'stored');
  assert.equal(fromStored.credentials.project_id, 'gen-lang-client-0384437564');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-adc-'));
  const adcFile = path.join(tmpDir, 'adc.json');
  fs.writeFileSync(adcFile, JSON.stringify({ client_id: 'cid', client_secret: 'sec', refresh_token: 'ref', type: 'authorized_user' }));
  const fromEnv = vertex.resolveCredentials({ env: { GOOGLE_APPLICATION_CREDENTIALS: adcFile } });
  assert.equal(fromEnv.source, 'env');
  assert.equal(fromEnv.credentials.refresh_token, 'ref');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('vertex fetches live model list and mints OAuth2 token from service account JWT', async () => {
  vertex.clearTokenCache();
  const sa = makeEphemeralSa();
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (String(url).includes('oauth2.googleapis.com/token')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: 'ya29.test-token', expires_in: 3600 }),
      };
    }
    if (String(url).includes('/publishers/google/models')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          publisherModels: [
            { name: 'publishers/google/models/gemini-4-hydrogen', displayName: 'Gemini 4 Hydrogen' },
            { name: 'publishers/google/models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash' },
            { name: 'publishers/google/models/gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite' },
            { name: 'publishers/google/models/imagen-3.0', displayName: 'Imagen 3' },
          ],
        }),
      };
    }
    throw new Error('Unexpected URL: ' + url);
  };

  const models = await vertex.fetchVertexModels({ credentials: sa, project: 'gen-lang-client-0384437564', location: 'global', fetchImpl });
  assert.deepEqual(models.map((m) => m.id), ['gemini-4-hydrogen', 'gemini-3.8-flash', 'gemini-3.5-flash-lite']);
  assert.ok(calls.some((c) => c.url.includes('oauth2.googleapis.com/token')));
  assert.ok(calls.some((c) => c.url.includes('aiplatform.googleapis.com/v1beta1/publishers/google/models')));
});

test('vertex streamVertex sends multimodal screenshot + question to generateContent SSE endpoint', async () => {
  vertex.clearTokenCache();
  const sa = makeEphemeralSa();
  let capturedBody = null;
  let capturedUrl = '';
  const fetchImpl = async (url, opts) => {
    if (String(url).includes('oauth2.googleapis.com/token')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'ya29.test-token', expires_in: 3600 }) };
    }
    capturedUrl = url;
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      text: async () => [
        'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Click ' }] } }] }),
        'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Save.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 4 } }),
        '',
      ].join('\n'),
    };
  };

  const tokens = [];
  let usage = null;
  const out = await vertex.streamVertex({
    credentials: sa,
    project: 'gen-lang-client-0384437564',
    location: 'global',
    model: 'gemini-3.8-flash',
    system: 'Guide the user.',
    turns: [{ role: 'user', text: 'Where do I save?' }],
    imageDataUrl: 'data:image/jpeg;base64,/9j/4AAQ',
    onToken: (t) => tokens.push(t),
    onUsage: (u) => { usage = u; },
    fetchImpl,
  });

  assert.equal(out, 'Click Save.');
  assert.deepEqual(tokens, ['Click ', 'Save.']);
  assert.deepEqual(usage, { input_tokens: 120, output_tokens: 4 });
  assert.ok(capturedUrl.includes('/projects/gen-lang-client-0384437564/locations/global/publishers/google/models/gemini-3.8-flash:streamGenerateContent?alt=sse'));
  assert.equal(capturedBody.contents[0].parts[1].inlineData.mimeType, 'image/jpeg');
  assert.equal(capturedBody.contents[0].parts[1].inlineData.data, '/9j/4AAQ');
});

test('createLLM integrates vertex provider with custom ID fallback and light tier', () => {
  const sa = makeEphemeralSa();
  const baseSettings = {
    provider: 'vertex',
    smart: false,
    apiKeys: { vertex: JSON.stringify(sa) },
    vertexProject: 'gen-lang-client-0384437564',
    vertexLocation: 'global',
    models: { vertex: { ...vertex.DEFAULT_MODELS } },
  };

  const fastLlm = createLLM(baseSettings);
  assert.equal(fastLlm.provider, 'vertex');
  assert.equal(fastLlm.model, 'gemini-3.8-flash');
  assert.equal(fastLlm.ready, true);

  const smartLlm = createLLM({ ...baseSettings, smart: true });
  assert.equal(smartLlm.model, 'gemini-4-hydrogen');

  const lightLlm = createLLM({ ...baseSettings, tier: 'light' });
  assert.equal(lightLlm.model, 'gemini-3.5-flash-lite');

  const customLlm = createLLM({ ...baseSettings, vertexModelCustom: 'gemini-custom-preview' });
  assert.equal(customLlm.model, 'gemini-custom-preview');
});
