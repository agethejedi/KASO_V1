function json(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST,OPTIONS',
      'access-control-allow-headers': 'Content-Type, Authorization'
    },
    ...init
  });
}

function classify(score, thresholds) {
  if (score >= thresholds.high) return 'high';
  if (score >= thresholds.moderate) return 'moderate';
  if (score >= thresholds.low) return 'low';
  return 'minimal';
}

function inferFactorFromTranscript(factor, transcriptText) {
  const transcript = String(transcriptText || '').toLowerCase();
  if (!transcript.trim()) return false;
  const positives = Array.isArray(factor.positiveCues) ? factor.positiveCues : [];
  const negatives = Array.isArray(factor.negativeCues) ? factor.negativeCues : [];
  const positiveHit = positives.some((cue) => transcript.includes(String(cue).toLowerCase()));
  const negativeHit = negatives.some((cue) => transcript.includes(String(cue).toLowerCase()));
  return positiveHit && !negativeHit;
}

function buildNextSteps(playbookId, level, matchedFactors, coercionSignals = [], stressSignals = []) {
  const steps = [];
  const ids = new Set((matchedFactors || []).map((f) => f.id));

  if (playbookId === 'remote-access') {
    if (ids.has('active_session')) {
      steps.push('Disconnect the remote session immediately and remove internet access if needed.');
    }
    if (ids.has('bank_login_during_session')) {
      steps.push('Reset online banking credentials and review recent account activity.');
    }
    if (ids.has('money_move_instruction')) {
      steps.push('Pause any outgoing movement of funds and escalate for urgent fraud review.');
    }
    if (level === 'high') {
      steps.push('Escalate to a fraud specialist and consider temporary digital access restrictions.');
    }
  }

  if (playbookId === 'wire-request') {
    if (ids.has('changed_instructions')) {
      steps.push('Independently verify payment instructions using a trusted number already on file.');
    }
    if (ids.has('on_phone_with_third_party')) {
      steps.push('Pause the transfer and ask the customer to end the third-party call before proceeding.');
    }
    if (ids.has('independent_verification_missing')) {
      steps.push('Require independent recipient verification before release of funds.');
    }
    if (level === 'high') {
      steps.push('Recommend hold / escalation pending analyst review.');
    }
  }

  if (coercionSignals.some((s) => s.id === 'live_coaching')) {
    steps.push('Separate the client from the third party and continue only after the outside caller or messenger is disconnected.');
  }
  if (coercionSignals.some((s) => s.id === 'secrecy_pressure')) {
    steps.push('Use a warning script and document that the client was pressured to keep the transaction secret.');
  }
  if (stressSignals.some((s) => s.id === 'confusion')) {
    steps.push('Slow the interview down and verify the payment purpose in the client’s own words.');
  }
  if (stressSignals.some((s) => s.id === 'hesitation')) {
    steps.push('Ask one question at a time and reconfirm key facts before allowing funds movement.');
  }

  if (!steps.length) {
    steps.push('Proceed with standard enhanced verification and document responses.');
  }

  return Array.from(new Set(steps));
}

function countCueMatches(transcript, cues) {
  const haystack = String(transcript || '').toLowerCase();
  return cues.reduce((count, cue) => count + (haystack.includes(String(cue).toLowerCase()) ? 1 : 0), 0);
}

function detectCoercionSignals(transcriptText = '') {
  const transcript = String(transcriptText || '').toLowerCase();
  const catalog = [
    {
      id: 'live_coaching',
      label: 'Possible live coaching',
      severity: 'high',
      cues: ['on the phone with', 'they are guiding me', 'walking me through', 'texting me right now', 'telling me what to say', 'coaching me', 'speaker phone'],
      explanation: 'The client appears to be receiving real-time direction from another party.'
    },
    {
      id: 'secrecy_pressure',
      label: 'Secrecy pressure',
      severity: 'high',
      cues: ['do not tell the bank', 'keep it secret', 'do not tell anyone', 'confidential', 'private matter'],
      explanation: 'The client references secrecy or instructions not to involve the bank.'
    },
    {
      id: 'urgency_pressure',
      label: 'Urgency pressure',
      severity: 'moderate',
      cues: ['right away', 'immediately', 'urgent', 'hurry', 'today only', 'before it is too late', 'right now'],
      explanation: 'The transcript includes urgency language often used in scam coaching.'
    },
    {
      id: 'authority_impersonation',
      label: 'Authority impersonation',
      severity: 'moderate',
      cues: ['support', 'fraud department', 'apple', 'microsoft', 'government', 'irs', 'fbi', 'police', 'bank investigator'],
      explanation: 'The client may be responding to a claimed authority or institution.'
    },
    {
      id: 'fear_or_threat',
      label: 'Fear or threat language',
      severity: 'moderate',
      cues: ['my account will be locked', 'i will lose my money', 'they threatened', 'i was scared', 'panic', 'compromised', 'frozen unless'],
      explanation: 'The client uses fear-based language consistent with social-engineering pressure.'
    }
  ];

  return catalog
    .map((signal) => ({ ...signal, matches: countCueMatches(transcript, signal.cues) }))
    .filter((signal) => signal.matches > 0)
    .sort((a, b) => b.matches - a.matches);
}

function detectStressSignals(transcriptText = '') {
  const transcript = String(transcriptText || '').toLowerCase();
  const catalog = [
    {
      id: 'confusion',
      label: 'Confusion or uncertainty',
      severity: 'moderate',
      cues: ['i do not know', "i don't know", 'not sure', 'i guess', 'maybe', 'i think so', 'hard to explain'],
      explanation: 'The client sounds unsure or cannot explain the situation clearly.'
    },
    {
      id: 'hesitation',
      label: 'Hesitation markers',
      severity: 'low',
      cues: ['um', 'uh', 'let me think', 'hold on', 'wait', 'sort of'],
      explanation: 'The client uses language that may indicate hesitation or uncertainty.'
    },
    {
      id: 'distress',
      label: 'Distress language',
      severity: 'moderate',
      cues: ['worried', 'nervous', 'anxious', 'scared', 'upset', 'shaking'],
      explanation: 'The client describes a stressed or distressed emotional state.'
    },
    {
      id: 'contradiction',
      label: 'Potential contradiction',
      severity: 'moderate',
      cues: ['actually', 'but then', 'wait no', 'that is not right', 'i mean'],
      explanation: 'The client may be revising or contradicting earlier statements.'
    }
  ];

  return catalog
    .map((signal) => ({ ...signal, matches: countCueMatches(transcript, signal.cues) }))
    .filter((signal) => signal.matches > 0)
    .sort((a, b) => b.matches - a.matches);
}

function summarizeRiskState(level, matchedFactors, coercionSignals, stressSignals) {
  if (level === 'high') return 'high-risk';
  if (coercionSignals.some((s) => s.severity === 'high')) return 'high-risk';
  if (matchedFactors.length >= 2 || stressSignals.length >= 2) return 'elevated';
  if (level === 'low') return 'watch';
  return 'limited';
}

function buildFallbackNarrative({ playbook, level, recommendation, matchedFactors, coercionSignals, stressSignals, transcriptText }) {
  const factorText = matchedFactors.length
    ? matchedFactors.map((f) => f.name).join(', ')
    : 'no confirmed structured factors';
  const coercionText = coercionSignals.length
    ? coercionSignals.map((s) => s.label).join(', ')
    : 'no explicit coercion markers';
  const stressText = stressSignals.length
    ? stressSignals.map((s) => s.label).join(', ')
    : 'no clear stress markers';
  const transcriptHint = String(transcriptText || '').trim()
    ? 'The transcript provides some free-form detail that should be documented in the case file.'
    : 'The interview was largely structured, so a follow-up narrative from the analyst may still help.';

  return `This ${playbook?.name || 'fraud review'} interview resulted in a ${level} risk assessment with a recommendation to ${recommendation.toLowerCase()}. Triggered factors: ${factorText}. Coercion assessment: ${coercionText}. Stress assessment: ${stressText}. ${transcriptHint}`;
}

function buildReasoningSummary({ matchedFactors, coercionSignals, stressSignals }) {
  const bullets = [];
  if (matchedFactors.length) {
    bullets.push(`Structured risk factors triggered: ${matchedFactors.map((f) => `${f.name} (${f.weight})`).join(', ')}.`);
  }
  if (coercionSignals.length) {
    bullets.push(`Coercion indicators detected: ${coercionSignals.map((s) => s.label).join(', ')}.`);
  }
  if (stressSignals.length) {
    bullets.push(`Stress or uncertainty indicators detected: ${stressSignals.map((s) => s.label).join(', ')}.`);
  }
  if (!bullets.length) bullets.push('No strong structured, coercion, or stress indicators were detected from the current answers/transcript.');
  return bullets;
}

function buildRecommendedFollowUps(playbookId, matchedFactors, coercionSignals, stressSignals) {
  const questions = [];
  const ids = new Set((matchedFactors || []).map((f) => f.id));

  if (playbookId === 'remote-access') {
    if (ids.has('remote_software_installed')) {
      questions.push('What specific remote-access software was installed, and is it still on the device right now?');
    }
    if (ids.has('money_move_instruction')) {
      questions.push('Who told you to move money, and what reason did they give for moving it?');
    }
  }

  if (playbookId === 'wire-request') {
    if (ids.has('changed_instructions')) {
      questions.push('How did the beneficiary information change, and did you verify that change using a trusted number?');
    }
    if (ids.has('on_phone_with_third_party')) {
      questions.push('Can you disconnect from the third party now and explain the payment purpose in your own words?');
    }
  }

  if (coercionSignals.some((s) => s.id === 'live_coaching')) {
    questions.push('Are you comfortable ending the outside call or message thread so we can continue privately?');
  }
  if (coercionSignals.some((s) => s.id === 'secrecy_pressure')) {
    questions.push('What exactly were you told would happen if you spoke with the bank or delayed the transaction?');
  }
  if (stressSignals.some((s) => s.id === 'confusion')) {
    questions.push('Please describe the purpose of the transaction in your own words, without using the other party’s script.');
  }

  return Array.from(new Set(questions)).slice(0, 5);
}

async function maybeGenerateOpenAINarrative(env, payload) {
  if (!env.OPENAI_API_KEY) return null;

  const model = env.OPENAI_CASE_MODEL || 'gpt-4.1-mini';
  const prompt = [
    'You are a bank fraud analyst copilot.',
    'Return strict JSON with keys: narrative, customer_state, risk_rationale, recommended_followups.',
    'narrative should be 3-5 sentences, concise and audit-friendly.',
    'customer_state should be one of: calm, uncertain, pressured, distressed, coached.',
    'risk_rationale should be an array of short strings.',
    'recommended_followups should be an array of up to 5 short follow-up questions.',
    `Playbook: ${payload.playbook?.name || 'Unknown'}`,
    `Recommendation: ${payload.recommendation}`,
    `Level: ${payload.level}`,
    `Matched factors: ${payload.matchedFactors.map((f) => f.name).join(', ') || 'none'}`,
    `Coercion signals: ${payload.coercionSignals.map((s) => s.label).join(', ') || 'none'}`,
    `Stress signals: ${payload.stressSignals.map((s) => s.label).join(', ') || 'none'}`,
    `Transcript:\n${String(payload.transcriptText || '').slice(0, 5000) || 'No transcript provided.'}`
  ].join('\n\n');

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      input: prompt,
      max_output_tokens: 500,
      text: {
        format: {
          type: 'json_schema',
          name: 'fraud_case_narrative',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              narrative: { type: 'string' },
              customer_state: {
                type: 'string',
                enum: ['calm', 'uncertain', 'pressured', 'distressed', 'coached']
              },
              risk_rationale: {
                type: 'array',
                items: { type: 'string' }
              },
              recommended_followups: {
                type: 'array',
                items: { type: 'string' }
              }
            },
            required: ['narrative', 'customer_state', 'risk_rationale', 'recommended_followups']
          }
        }
      }
    })
  });

  if (!response.ok) {
    return null;
  }

  const data = await response.json().catch(() => null);
  const textContent = data?.output_text || data?.output?.[0]?.content?.find?.((c) => c.type === 'output_text')?.text;
  if (!textContent) return null;

  try {
    return JSON.parse(textContent);
  } catch {
    return null;
  }
}

export async function onRequestOptions() {
  return json({ ok: true });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const body = await request.json().catch(() => ({}));
  const playbook = body?.playbook;
  const answers = body?.answers || {};
  const transcriptText = body?.transcriptText || '';
  if (!playbook?.id || !Array.isArray(playbook?.factors)) {
    return json({ error: 'Invalid playbook supplied.' }, { status: 400 });
  }

  let score = 0;
  const matchedFactors = [];

  for (const factor of playbook.factors) {
    const raw = answers[factor.id];
    const normalized = String(raw || '').trim().toLowerCase();
    const isTriggeredByAnswer = ['yes', 'y', 'true', 'triggered'].includes(normalized);
    const isTriggeredByTranscript = !isTriggeredByAnswer && inferFactorFromTranscript(factor, transcriptText);
    if (isTriggeredByAnswer || isTriggeredByTranscript) {
      score += Number(factor.weight || 0);
      matchedFactors.push({
        id: factor.id,
        name: factor.name,
        weight: factor.weight,
        resolutionHint: factor.resolutionHint || ''
      });
    }
  }

  const thresholds = playbook.thresholds || { low: 20, moderate: 40, high: 60 };
  const coercionSignals = detectCoercionSignals(transcriptText);
  const stressSignals = detectStressSignals(transcriptText);

  score += coercionSignals.reduce((sum, s) => sum + (s.severity === 'high' ? 12 : 6), 0);
  score += stressSignals.reduce((sum, s) => sum + (s.severity === 'moderate' ? 4 : 2), 0);

  const level = classify(score, thresholds);
  let recommendation = 'Proceed with caution';
  if (level === 'moderate') recommendation = 'Challenge and review';
  if (level === 'high') recommendation = 'Hold / escalate';
  if (level === 'minimal') recommendation = 'Low apparent risk';

  const nextSteps = buildNextSteps(playbook.id, level, matchedFactors, coercionSignals, stressSignals);
  const recommendedFollowUps = buildRecommendedFollowUps(playbook.id, matchedFactors, coercionSignals, stressSignals);
  const reasoningSummary = buildReasoningSummary({ matchedFactors, coercionSignals, stressSignals });

  const basePayload = {
    playbook,
    level,
    recommendation,
    matchedFactors,
    coercionSignals,
    stressSignals,
    transcriptText,
  };

  const aiNarrative = await maybeGenerateOpenAINarrative(env, {
    ...basePayload,
    score,
  });

  const narrative = aiNarrative?.narrative || buildFallbackNarrative({
    ...basePayload,
    recommendation,
  });

  const customerState = aiNarrative?.customer_state || (
    coercionSignals.some((s) => s.id === 'live_coaching') ? 'coached' :
    stressSignals.some((s) => s.id === 'distress') ? 'distressed' :
    stressSignals.some((s) => s.id === 'confusion') ? 'uncertain' : 'calm'
  );

  const modelReasoning = Array.isArray(aiNarrative?.risk_rationale) && aiNarrative.risk_rationale.length
    ? aiNarrative.risk_rationale
    : reasoningSummary;

  const finalFollowUps = Array.isArray(aiNarrative?.recommended_followups) && aiNarrative.recommended_followups.length
    ? aiNarrative.recommended_followups
    : recommendedFollowUps;

  return json({
    ok: true,
    playbookId: playbook.id,
    score,
    level,
    recommendation,
    riskState: summarizeRiskState(level, matchedFactors, coercionSignals, stressSignals),
    customerState,
    matchedFactors,
    coercionSignals,
    stressSignals,
    reasoningSummary: modelReasoning,
    narrative,
    nextSteps,
    recommendedFollowUps: finalFollowUps,
  });
}
