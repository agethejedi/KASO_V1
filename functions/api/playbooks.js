const STORAGE_KEY = 'fraud-response-playbooks-v1';

async function getSeed(context) {
  const url = new URL('/data/seed-playbooks.json', context.request.url).toString();
  const resp = await fetch(url);
  return resp.json();
}

function json(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'Content-Type, Authorization'
    },
    ...init
  });
}

async function loadPlaybooks(context) {
  const kv = context.env?.PLAYBOOKS;
  if (kv) {
    const stored = await kv.get(STORAGE_KEY, 'json');
    if (stored?.playbooks?.length) return stored;
    const seed = await getSeed(context);
    await kv.put(STORAGE_KEY, JSON.stringify(seed));
    return seed;
  }
  return getSeed(context);
}

export async function onRequestOptions() {
  return json({ ok: true });
}

export async function onRequestGet(context) {
  const data = await loadPlaybooks(context);
  return json(data);
}

export async function onRequestPost(context) {
  const auth = context.request.headers.get('authorization') || '';
  const expected = context.env?.ADMIN_BEARER_TOKEN;
  if (!expected || auth !== `Bearer ${expected}`) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await context.request.json();
  if (!body || !Array.isArray(body.playbooks)) {
    return json({ error: 'Invalid payload' }, { status: 400 });
  }

  const payload = {
    version: Number(body.version || Date.now()),
    playbooks: body.playbooks
  };

  const kv = context.env?.PLAYBOOKS;
  if (!kv) {
    return json({
      ok: false,
      warning: 'PLAYBOOKS KV binding not configured. Changes were validated but not persisted server-side.',
      payload
    });
  }

  await kv.put(STORAGE_KEY, JSON.stringify(payload));
  return json({ ok: true, payload });
}
