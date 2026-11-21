'use strict';
// Opt-in, unofficial Gemini Web client using __Secure-1PSID cookie RPC to a Temporary Chat.
// NOT default: Vertex AI / Gemini API stays the default and acts as automatic fallback.
// Warning: Unofficial, can break at any time, and risks the Google account.

const GEMINI_WEB_URL = 'https://gemini.google.com/app';
const GEMINI_RPC_URL = 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate';
const UNOFFICIAL_WARNING = 'Unofficial & risky: Uses your __Secure-1PSID cookie to call Gemini web Temporary Chat. It can break at any time and risks your Google account. Vertex AI / Gemini API remains the default and acts as fallback.';

function extractTokens(html) {
  const snlm0e = (/"SNlM0e":"([^"]+)"/.exec(html) || [])[1] || '';
  const cfb2h = (/"cfb2h":"([^"]+)"/.exec(html) || [])[1] || '';
  const fdrfje = (/"FdrFJe":"([^"]+)"/.exec(html) || [])[1] || '';
  return { snlm0e, cfb2h, fdrfje };
}

function buildCookieHeader(psid, psidts) {
  const parts = [];
  if (psid) parts.push(`__Secure-1PSID=${String(psid).trim()}`);
  if (psidts) parts.push(`__Secure-1PSIDTS=${String(psidts).trim()}`);
  return parts.join('; ');
}

function parseStreamGenerateResponse(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  let latestText = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('[')) continue;
    try {
      const outer = JSON.parse(trimmed);
      if (!Array.isArray(outer)) continue;
      for (const frame of outer) {
        if (!Array.isArray(frame) || frame[0] !== 'wrb.fr' || typeof frame[2] !== 'string') continue;
        const inner = JSON.parse(frame[2]);
        const candidates = inner && inner[4];
        if (Array.isArray(candidates) && candidates[0] && Array.isArray(candidates[0][1])) {
          const text = candidates[0][1][0];
          if (typeof text === 'string' && text.length >= latestText.length) latestText = text;
        }
      }
    } catch (_) {}
  }
  return latestText;
}

async function callGeminiWeb({ psid, psidts, system, turns, onToken = () => {}, signal, fetchImpl = globalThis.fetch }) {
  const cookie = buildCookieHeader(psid, psidts);
  if (!cookie) throw new Error('__Secure-1PSID cookie is not set.');

  const pageRes = await fetchImpl(GEMINI_WEB_URL, {
    method: 'GET',
    headers: {
      Cookie: cookie,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    signal,
  });
  if (!pageRes.ok) throw new Error(`Gemini web session fetch failed (${pageRes.status})`);
  const html = await pageRes.text();
  const { snlm0e, cfb2h, fdrfje } = extractTokens(html);
  if (!snlm0e) throw new Error('Gemini web cookie rejected or expired (SNlM0e missing).');

  const promptParts = [];
  if (system) promptParts.push(String(system));
  for (const t of turns || []) {
    if (t && t.text) promptParts.push(`${t.role === 'assistant' ? 'Assistant' : 'User'}: ${t.text}`);
  }
  const combinedPrompt = promptParts.join('\n\n');

  const reqPayload = JSON.stringify([
    null,
    JSON.stringify([
      [combinedPrompt, 0, null, null, null, null, 0],
      ['en'],
      ['', '', '', null, null, null, null, null, null, ''],
      null, null, null, [1], 0, null, null, 1, 0, null, null, null, null, null, [[0]], 0,
    ]),
  ]);

  const qs = new URLSearchParams({
    bl: cfb2h || 'boq_assistant-bard-web-server_20261101.00_p0',
    'f.sid': fdrfje || '',
    hl: 'en',
    rt: 'c',
  });

  const rpcRes = await fetchImpl(`${GEMINI_RPC_URL}?${qs.toString()}`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      Origin: 'https://gemini.google.com',
      Referer: 'https://gemini.google.com/',
    },
    body: new URLSearchParams({ 'f.req': reqPayload, at: snlm0e }).toString(),
    signal,
  });
  const bodyText = await rpcRes.text();
  if (!rpcRes.ok) throw new Error(`Gemini web RPC failed (${rpcRes.status})`);
  const text = parseStreamGenerateResponse(bodyText);
  if (!text) throw new Error('Gemini web returned an empty response.');
  onToken(text);
  return text;
}

module.exports = {
  GEMINI_WEB_URL,
  GEMINI_RPC_URL,
  UNOFFICIAL_WARNING,
  extractTokens,
  buildCookieHeader,
  parseStreamGenerateResponse,
  callGeminiWeb,
};
