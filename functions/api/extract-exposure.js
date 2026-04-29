/**
 * functions/api/extract-exposure.js
 * KASO V1 — Claude-assisted exposure extraction
 *
 * POST /api/extract-exposure
 *   Body: { transcript: [...], evidence: [...] }
 *   Reads the case transcript and evidence, extracts structured exposure amounts.
 *   Returns proposed values for analyst confirmation — does NOT save automatically.
 *
 * Returns:
 *   {
 *     ok: true,
 *     extracted: {
 *       requested: 12000,    // amount fraudster asked for
 *       sent:      8000,     // amount victim already sent
 *       recovered: 0,        // amount recovered (rare)
 *       currency:  'USD',
 *       confidence: 'high'|'medium'|'low',
 *       reasoning: 'one sentence explanation'
 *     }
 *   }
 */

function json(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin':  '*',
      'access-control-allow-methods': 'POST,OPTIONS',
      'access-control-allow-headers': 'Content-Type, Authorization',
    },
    ...init,
  });
}

export async function onRequestOptions() {
  return json({ ok: true });
}

export async function onRequestPost(context) {
  const { env, request } = context;

  if (!env?.ANTHROPIC_API_KEY) {
    return json({ error: 'ANTHROPIC_API_KEY is not configured.' }, { status: 400 });
  }

  let body = {};
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body.' }, { status: 400 }); }

  const { transcript, evidence } = body;
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return json({
      ok: true,
      extracted: {
        requested: null, sent: null, recovered: null,
        currency: 'USD', confidence: 'low',
        reasoning: 'No transcript available to analyze.',
      },
    });
  }

  // Build transcript text — exclude system messages
  const transcriptText = transcript
    .filter(t => t.role !== 'system')
    .map(t => `${t.role.toUpperCase()}: ${t.text}`)
    .join('\n');

  // Include evidence summary in case dollar amounts surface there
  const evidenceText = Array.isArray(evidence) && evidence.length > 0
    ? evidence.map(e => `[${e.type}] ${e.source}: ${e.result?.summary || ''}`).join('\n')
    : '';

  const system = `You are a fraud analyst extracting structured financial exposure data from case interviews.

Your job is to read the transcript and evidence and extract three specific dollar amounts:
1. REQUESTED — the amount the fraudster asked the victim to send (or invest, or pay)
2. SENT — the amount the victim has already sent or paid
3. RECOVERED — any amount that has been recovered or returned (almost always 0)

Rules:
- Only include amounts the user/victim actually mentioned in context of THIS fraud case
- Ignore hypothetical amounts, news references, or amounts mentioned about other situations
- Convert text amounts to numbers ("twelve thousand" → 12000, "$15K" → 15000, "two million" → 2000000)
- If the victim mentions multiple requested amounts, use the most recent or largest cumulative
- If the victim mentions multiple sent payments, sum them
- If an amount is unclear or not mentioned, return null for that field
- If you're guessing or interpolating, mark confidence as 'low'
- If victim explicitly stated the amount, mark confidence as 'high'
- If amount can be reasonably inferred but not directly stated, mark confidence as 'medium'

Return ONLY a JSON object, no markdown, no preamble:
{
  "requested": <number or null>,
  "sent":      <number or null>,
  "recovered": <number or null>,
  "currency":  "USD",
  "confidence": "high"|"medium"|"low",
  "reasoning":  "one sentence explaining what you found and how you interpreted it"
}`;

  const userMsg = `TRANSCRIPT:
${transcriptText}

${evidenceText ? `EVIDENCE NOTES:\n${evidenceText}\n` : ''}
Extract the three exposure amounts based on what the victim actually said.`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 600,
        system,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return json({ error: 'Anthropic API error.', detail: errText }, { status: resp.status });
    }

    const data = await resp.json();
    const raw  = data.content?.find(b => b.type === 'text')?.text || '{}';

    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      return json({ error: 'Failed to parse Claude response.', raw }, { status: 500 });
    }

    return json({
      ok: true,
      extracted: {
        requested:  typeof parsed.requested === 'number' ? parsed.requested : null,
        sent:       typeof parsed.sent      === 'number' ? parsed.sent      : null,
        recovered:  typeof parsed.recovered === 'number' ? parsed.recovered : null,
        currency:   parsed.currency   || 'USD',
        confidence: parsed.confidence || 'medium',
        reasoning:  parsed.reasoning  || '',
      },
    });

  } catch (err) {
    return json({ error: 'Extraction failed.', detail: String(err) }, { status: 500 });
  }
}
