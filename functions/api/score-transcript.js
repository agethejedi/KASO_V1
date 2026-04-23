/**
 * functions/api/score-transcript.js
 * KASO V1 — Realtime transcript scoring via Anthropic
 *
 * POST /api/score-transcript
 *
 * Takes a full Realtime session transcript and a playbook,
 * asks Claude to extract structured yes/no/unsure answers
 * for each playbook factor, returns an answers{} object
 * compatible with /api/evaluate.
 *
 * Body: {
 *   transcript: [{ role: 'agent'|'user', text: '...' }],
 *   playbook:   { id, name, factors: [...] }
 * }
 *
 * Returns: {
 *   ok: true,
 *   answers: { factorId: 'yes'|'no'|'unsure', ... },
 *   summary: 'brief extraction summary',
 *   confidence: 'high'|'medium'|'low'
 * }
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
    return json({ error: 'ANTHROPIC_API_KEY is not configured.' }, { status: 400 });
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { transcript, playbook } = body;

  if (!transcript?.length) {
    return json({ error: 'transcript array is required and must not be empty.' }, { status: 400 });
  }
  if (!playbook?.factors?.length) {
    return json({ error: 'playbook with factors is required.' }, { status: 400 });
  }

  // Build transcript text — exclude system messages
  const transcriptText = transcript
    .filter(t => t.role !== 'system')
    .map(t => `${t.role.toUpperCase()}: ${t.text}`)
    .join('\n');

  // Build factor list for Claude
  const factorList = playbook.factors.map((f, i) =>
    `${i + 1}. id="${f.id}" name="${f.name}" question="${f.question}"`
  ).join('\n');

  const system = `You are a fraud assessment analyst extracting structured answers from a voice interview transcript.

You will be given:
1. A transcript of a fraud assessment interview between an AGENT and a USER (the potential fraud victim)
2. A list of playbook factors the agent was supposed to cover

Your job is to read the transcript and determine whether each factor was answered YES, NO, or UNSURE by the user.

Rules:
- Only mark YES if the user clearly confirmed the factor occurred
- Mark NO if the user clearly denied the factor
- Mark UNSURE if the topic was not discussed, the user was unclear, or you cannot determine the answer from the transcript
- Base your answers ONLY on what was said in the transcript — do not infer or assume
- Return ONLY a valid JSON object with no markdown, no preamble, no explanation

Response format (return ONLY this JSON, nothing else):
{
  "answers": {
    "factor_id_here": "yes",
    "another_factor_id": "no",
    "yet_another_id": "unsure"
  },
  "summary": "one sentence describing what the transcript covered and how complete the interview was",
  "confidence": "high|medium|low"
}`;

  const userMsg = `PLAYBOOK: ${playbook.name}

FACTORS TO EVALUATE:
${factorList}

TRANSCRIPT:
${transcriptText}

Extract yes/no/unsure answers for each factor based solely on the transcript above. Return only the JSON object.`;

  // Call Anthropic
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
        model:      'claude-sonnet-4-6',
        max_tokens: 1000,
        system,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });
  } catch (err) {
    return json({ error: 'Failed to reach Anthropic API.', detail: String(err) }, { status: 502 });
  }

  if (!anthropicResp.ok) {
    const errText = await anthropicResp.text();
    return json({ error: 'Anthropic API error.', detail: errText }, { status: anthropicResp.status });
  }

  const data      = await anthropicResp.json();
  const raw       = data.content?.find(b => b.type === 'text')?.text || '{}';

  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return json({ error: 'Failed to parse Claude response as JSON.', raw }, { status: 500 });
  }

  // Validate — ensure every factor has an answer, default missing to 'unsure'
  const answers = {};
  for (const factor of playbook.factors) {
    const val = parsed.answers?.[factor.id];
    answers[factor.id] = (val === 'yes' || val === 'no') ? val : 'unsure';
  }

  return json({
    ok:         true,
    answers,
    summary:    parsed.summary    || '',
    confidence: parsed.confidence || 'medium',
  });
}
