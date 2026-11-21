'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { getPath: () => os.tmpdir() },
      safeStorage: { isEncryptionAvailable: () => false },
    };
  }
  return origLoad.apply(this, arguments);
};

const geminiWeb = require('../src/gemini-web');
const store = require('../src/store');
const { createLLM } = require('../src/llm');

test('gemini-web is NOT the default provider and requires explicit opt-in', async () => {
  const defaults = store.getSettings();
  assert.equal(defaults.provider, 'gemini');
  assert.equal(defaults.geminiWebOptIn, false);

  const llmDisabled = createLLM({
    provider: 'gemini-web',
    geminiWebOptIn: false,
    apiKeys: { geminiWeb: 'psid-cookie-value' },
    models: defaults.models,
  });
  assert.equal(llmDisabled.ready, false);
  await assert.rejects(() => llmDisabled.complete({ system: 'hi', turns: [{ role: 'user', text: 'test' }] }), /opt-in only/i);
});

test('gemini-web parses SNlM0e and Temporary Chat StreamGenerate response', async () => {
  const html = '<script>window.WIZ_global_data={"SNlM0e":"AJ_test_token","cfb2h":"boq_test","FdrFJe":"12345"};</script>';
  const tokens = geminiWeb.extractTokens(html);
  assert.equal(tokens.snlm0e, 'AJ_test_token');

  const rawRpc = [
    ")]}'",
    '123',
    JSON.stringify([['wrb.fr', null, JSON.stringify([null, ['cid', 'rid'], null, null, [['rcid', ['Hello from Temporary Chat!']]]])]]),
  ].join('\n');

  const calledUrls = [];
  const text = await geminiWeb.callGeminiWeb({
    psid: 'test_psid_value',
    system: 'Be concise.',
    turns: [{ role: 'user', text: 'Say hello' }],
    fetchImpl: async (url) => {
      calledUrls.push(String(url));
      if (String(url).includes('/app')) return { ok: true, status: 200, text: async () => html };
      return { ok: true, status: 200, text: async () => rawRpc };
    },
  });

  assert.equal(text, 'Hello from Temporary Chat!');
  assert.ok(calledUrls.some((u) => u.includes('StreamGenerate')));
});

test('Settings UI shows clear unofficial warning for Gemini Web', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'home', 'index.html'), 'utf8');
  assert.ok(html.includes('Unofficial'));
  assert.ok(html.includes('__Secure-1PSID'));
  assert.ok(html.includes('risks your Google account'));
  assert.ok(geminiWeb.UNOFFICIAL_WARNING.includes('risks your Google account'));
});
