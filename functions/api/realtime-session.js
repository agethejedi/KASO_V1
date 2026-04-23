/**
 * functions/api/realtime-session.js
 * KASO V1 — OpenAI Realtime ephemeral token via GA API
 */

function json(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
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

  if (!env.OPENAI_API_KEY) {
    return json({ error: 'OPENAI_API_KEY is not configured on the server.' }, { status: 400 });
  }

  const body         = await request.json().catch(() => ({}));
  const model        = env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
  const voice        = env.OPENAI_REALTIME_VOICE || 'marin';
  const instructions = body?.instructions || 'You are a calm fraud response voice agent.';

  // gpt-realtime only accepts minimal config at session creation.
  // turn_detection and input_audio_transcription are set post-connect
  // via session.update over the WebRTC data channel in app.js.
  const sessionConfig = {
    session: {
      type:  'realtime',
      model,
      instructions,
      audio: {
        output: { voice },
      },
    },
  };

  const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method:  'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(sessionConfig),
  });

  const rawText = await response.text();
  let parsed;
  try { parsed = JSON.parse(rawText); }
  catch { parsed = { raw: rawText }; }

  if (!response.ok) {
    return json({
      error:   parsed?.error?.message || 'Failed to create OpenAI Realtime client secret.',
      details: parsed,
    }, { status: response.status });
  }

  const value     = parsed?.value || parsed?.client_secret?.value || null;
  const expiresAt = parsed?.expires_at || parsed?.client_secret?.expires_at || null;

  return json({ ok: true, value, expires_at: expiresAt, model, voice });
}
