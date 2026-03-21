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

function buildNextSteps(playbookId, level, matchedFactors) {
  const steps = [];
  if (playbookId === 'remote-access') {
    if (matchedFactors.some((f) => f.id === 'active_session')) {
      steps.push('Disconnect the remote session immediately and remove internet access if needed.');
    }
    if (matchedFactors.some((f) => f.id === 'bank_login_during_session')) {
      steps.push('Reset online banking credentials and review recent account activity.');
    }
    if (matchedFactors.some((f) => f.id === 'money_move_instruction')) {
      steps.push('Pause any outgoing movement of funds and escalate for urgent fraud review.');
    }
    if (level === 'high') {
      steps.push('Escalate to a fraud specialist and consider temporary digital access restrictions.');
    }
  }
  if (playbookId === 'wire-request') {
    if (matchedFactors.some((f) => f.id === 'changed_instructions')) {
      steps.push('Independently verify payment instructions using a trusted number already on file.');
    }
    if (matchedFactors.some((f) => f.id === 'on_phone_with_third_party')) {
      steps.push('Pause the transfer and ask the customer to end the third-party call before proceeding.');
    }
    if (matchedFactors.some((f) => f.id === 'independent_verification_missing')) {
      steps.push('Require independent recipient verification before release of funds.');
    }
    if (level === 'high') {
      steps.push('Recommend hold / escalation pending analyst review.');
    }
  }
  if (!steps.length) {
    steps.push('Proceed with standard enhanced verification and document responses.');
  }
  return steps;
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

export async function onRequestOptions() {
  return json({ ok: true });
}

export async function onRequestPost(context) {
  const body = await context.request.json();
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
  const level = classify(score, thresholds);

  let recommendation = 'Proceed with caution';
  if (level === 'moderate') recommendation = 'Challenge and review';
  if (level === 'high') recommendation = 'Hold / escalate';
  if (level === 'minimal') recommendation = 'Low apparent risk';

  return json({
    ok: true,
    playbookId: playbook.id,
    score,
    level,
    recommendation,
    matchedFactors,
    nextSteps: buildNextSteps(playbook.id, level, matchedFactors)
  });
}
