/**
 * functions/api/analyze.js
 * KASO V1 — Anthropic API proxy for evidence analysis
 *
 * POST /api/analyze
 *
 * Accepts three evidence types:
 *   { type: 'link',       url }
 *   { type: 'screenshot', imageBase64, mediaType }
 *   { type: 'social',     platform, profileUrl, context }
 *   { type: 'crypto',     addresses: [{ address, chain }] }
 *
 * Returns Anthropic's parsed JSON result for each type.
 * ANTHROPIC_API_KEY is read from Cloudflare secrets — never exposed to the client.
 */

function json(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST,OPTIONS',
      'access-control-allow-headers': 'Content-Type',
    },
    ...init,
  });
}

export async function onRequestOptions() {
  return json({ ok: true });
}

export async function onRequestPost(context) {
  const { env, request } = context;

  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' }, { status: 400 });
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { type } = body;
  if (!type) {
    return json({ error: 'type is required (link | screenshot | social | crypto).' }, { status: 400 });
  }

  let system  = '';
  let content = null; // string or array of content blocks

  // ── Build system prompt + user content per evidence type ──────────────────

  if (type === 'link') {
    const { url } = body;
    if (!url) return json({ error: 'url is required for type=link.' }, { status: 400 });

    system = `You are a fraud detection AI analyzing URLs submitted by potential scam victims.
Respond ONLY with a JSON object, no markdown backticks, no preamble:
{
  "verdict": "dangerous"|"suspicious"|"clean",
  "risk_score": 0-100,
  "findings": [{"severity":"red"|"amber"|"green","text":"finding"}],
  "summary": "one sentence summary",
  "score_contribution": 0-40
}
Analyze for: phishing patterns, lookalike domains, suspicious TLDs, IP-based URLs,
URL shorteners hiding destinations, tech support scam domains, fake bank/Microsoft/Apple sites,
remote access tool download pages (AnyDesk, TeamViewer clones), newly registered domains.`;

    content = `Analyze this URL for fraud risk: ${url}`;
  }

  else if (type === 'screenshot') {
    const { imageBase64, mediaType = 'image/jpeg' } = body;
    if (!imageBase64) return json({ error: 'imageBase64 is required for type=screenshot.' }, { status: 400 });

    system = `You are a fraud detection AI analyzing screenshots submitted by potential scam victims.
Respond ONLY with a JSON object, no markdown backticks, no preamble:
{
  "verdict": "dangerous"|"suspicious"|"clean",
  "risk_score": 0-100,
  "image_type": "brief description of what the image shows",
  "findings": [{"severity":"red"|"amber"|"green","text":"specific finding"}],
  "summary": "one sentence summary",
  "score_contribution": 0-40
}
Look for: fake tech support pop-ups, spoofed brand logos (Microsoft, Apple, banks),
fake error messages, phishing email screenshots, remote access software prompts,
urgency language, fake virus warnings, suspicious wire transfer instructions,
email header anomalies, caller ID spoofing screenshots.`;

    content = [
      {
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: imageBase64 },
      },
      {
        type: 'text',
        text: 'Analyze this screenshot for fraud indicators. Return only the JSON object.',
      },
    ];
  }

  else if (type === 'social') {
    const { platform = 'Unknown', profileUrl = '', context: ctx = '' } = body;
    if (!profileUrl && !ctx) {
      return json({ error: 'profileUrl or context is required for type=social.' }, { status: 400 });
    }

    system = `You are a fraud detection AI analyzing social media profiles and messages submitted by potential scam victims.
Respond ONLY with a JSON object, no markdown backticks, no preamble:
{
  "verdict": "dangerous"|"suspicious"|"clean",
  "risk_score": 0-100,
  "findings": [{"severity":"red"|"amber"|"green","text":"specific finding"}],
  "summary": "one sentence summary",
  "score_contribution": 0-40
}
Analyze for: romance scam patterns, fake investment advisor profiles, impersonation of real people
or institutions, urgency or coercion in messages, requests for money or gift cards,
pig butchering scam characteristics (fake crypto returns), fake job offer patterns,
newly created account signals, overly perfect profile indicators.`;

    content = `Platform: ${platform}
Profile URL / Username: ${profileUrl || 'not provided'}
Message or context: ${ctx || 'not provided'}

Analyze this social media submission for fraud risk.`;
  }

  else if (type === 'crypto') {
    const { addresses } = body;
    if (!Array.isArray(addresses) || !addresses.length) {
      return json({ error: 'addresses array is required for type=crypto.' }, { status: 400 });
    }

    system = `You are a blockchain fraud analyst analyzing crypto wallet addresses submitted by a potential scam victim.
Respond ONLY with a JSON object, no markdown backticks, no preamble:
{
  "verdict": "dangerous"|"suspicious"|"clean",
  "risk_score": 0-100,
  "addresses": [
    {"address":"the address","chain":"detected chain","risk":"high"|"medium"|"low","finding":"specific finding"}
  ],
  "findings": [{"severity":"red"|"amber"|"green","text":"overall finding"}],
  "summary": "one sentence overall summary",
  "score_contribution": 0-40
}
Analyze for: known scam wallet patterns, high-risk chain associations, romance scam /
pig butchering patterns, mixing service indicators, advance fee fraud patterns.
Note: any unsolicited request to send crypto to an unknown party is itself a high-risk signal
regardless of address history.`;

    const addrList = addresses.map((a, i) => `${i + 1}. ${a.chain}: ${a.address}`).join('\n');
    content = `Analyze these crypto wallet addresses submitted by a potential fraud victim:\n${addrList}\n\nThese were given to the user by someone asking them to send cryptocurrency.`;
  }

  else {
    return json({ error: `Unknown type: ${type}. Must be link | screenshot | social | crypto.` }, { status: 400 });
  }

  // ── Call Anthropic ─────────────────────────────────────────────────────────

  let anthropicResp;
  try {
    anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system,
        messages: [{ role: 'user', content }],
      }),
    });
  } catch (err) {
    return json({ error: 'Failed to reach Anthropic API.', detail: String(err) }, { status: 502 });
  }

  if (!anthropicResp.ok) {
    const errText = await anthropicResp.text();
    return json({ error: 'Anthropic API error.', detail: errText }, { status: anthropicResp.status });
  }

  const data = await anthropicResp.json();
  const raw  = data.content?.find((b) => b.type === 'text')?.text || '{}';

  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return json({ error: 'Failed to parse Anthropic response as JSON.', raw }, { status: 500 });
  }

  return json({ ok: true, result: parsed });
}
