/**
 * functions/api/cases.js
 * KASO V1 — Case management endpoint
 *
 * GET    /api/cases              → list cases (by date or status)
 * GET    /api/cases?id=RXL-...   → single case by ID
 * POST   /api/cases              → create new case (called by user at session start)
 * PATCH  /api/cases              → update case (score, evidence, transcript, disposition)
 *
 * KV binding: CASES
 *
 * Key schema:
 *   case:{caseId}                        → full case object (JSON)
 *   case-index:date:{YYYY-MM-DD}         → JSON array of caseIds opened that day
 *   case-index:status:{status}           → JSON array of caseIds with that status
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

function json(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
      'access-control-allow-headers': 'Content-Type, Authorization',
    },
    ...init,
  });
}

function generateCaseId() {
  const ts   = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `RXL-${ts}-${rand}`;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function isAuthorized(request, env) {
  const auth     = request.headers.get('authorization') || '';
  const expected = env?.ADMIN_BEARER_TOKEN;
  return expected && auth === `Bearer ${expected}`;
}

// ─── KV helpers ───────────────────────────────────────────────────────────────

async function getCase(kv, caseId) {
  return await kv.get(`case:${caseId}`, 'json');
}

async function putCase(kv, caseObj) {
  await kv.put(`case:${caseObj.id}`, JSON.stringify(caseObj));
}

async function addToIndex(kv, indexKey, caseId) {
  const existing = (await kv.get(indexKey, 'json')) || [];
  if (!existing.includes(caseId)) {
    existing.unshift(caseId); // newest first
    await kv.put(indexKey, JSON.stringify(existing));
  }
}

async function removeFromIndex(kv, indexKey, caseId) {
  const existing = (await kv.get(indexKey, 'json')) || [];
  await kv.put(indexKey, JSON.stringify(existing.filter((id) => id !== caseId)));
}

async function resolveCases(kv, ids, limit = 50, offset = 0) {
  const page   = ids.slice(offset, offset + limit);
  const cases  = await Promise.all(page.map((id) => kv.get(`case:${id}`, 'json').catch(() => null)));
  return cases.filter(Boolean);
}

// ─── CORS preflight ───────────────────────────────────────────────────────────

export async function onRequestOptions() {
  return json({ ok: true });
}

// ─── GET /api/cases ───────────────────────────────────────────────────────────
//
// Query params:
//   ?id=RXL-...          single case lookup
//   ?date=YYYY-MM-DD     cases opened on date (default: today)
//   ?status=open|complete|escalated|reviewing|closed|abandoned
//   ?limit=50            page size (max 100)
//   ?offset=0            pagination offset

export async function onRequestGet(context) {
  const { env, request } = context;

  if (!isAuthorized(request, env)) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const kv = env?.CASES;
  if (!kv) {
    return json({ error: 'CASES KV binding not configured.' }, { status: 503 });
  }

  const url    = new URL(request.url);
  const id     = url.searchParams.get('id');
  const date   = url.searchParams.get('date') || todayKey();
  const status = url.searchParams.get('status');
  const limit  = Math.min(parseInt(url.searchParams.get('limit')  || '50', 10), 100);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  // Single case
  if (id) {
    const caseObj = await getCase(kv, id);
    if (!caseObj) return json({ error: 'Case not found.' }, { status: 404 });
    return json({ ok: true, case: caseObj });
  }

  // By status
  if (status) {
    const ids   = (await kv.get(`case-index:status:${status}`, 'json')) || [];
    const cases = await resolveCases(kv, ids, limit, offset);
    return json({ ok: true, cases, total: ids.length, limit, offset });
  }

  // By date (default today)
  const ids   = (await kv.get(`case-index:date:${date}`, 'json')) || [];
  const cases = await resolveCases(kv, ids, limit, offset);
  return json({ ok: true, cases, date, total: ids.length, limit, offset });
}

// ─── POST /api/cases ──────────────────────────────────────────────────────────
//
// Called by the frontend at session start — no auth required.
// Body: { user: { first, last, email, phone }, playbook: { id, name } }
// Returns: { ok, caseId, createdAt }

export async function onRequestPost(context) {
  const { env, request } = context;

  const kv = env?.CASES;

  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const user     = body?.user     || {};
  const playbook = body?.playbook || {};

  if (!user.email || !user.first) {
    return json({ error: 'user.first and user.email are required.' }, { status: 400 });
  }

  const caseId    = generateCaseId();
  const createdAt = new Date().toISOString();

  const caseObj = {
    id:        caseId,
    createdAt,
    updatedAt: createdAt,
    status:    'open',

    user: {
      first: String(user.first || '').trim(),
      last:  String(user.last  || '').trim(),
      email: String(user.email || '').trim().toLowerCase(),
      phone: String(user.phone || '').trim(),
    },

    playbook: {
      id:   String(playbook.id   || '').trim(),
      name: String(playbook.name || '').trim(),
    },

    // Populated by PATCH after session ends
    score:          null,
    level:          null,
    recommendation: null,
    matchedFactors: [],
    nextSteps:      [],
    transcript:     [],
    evidence:       [],

    // Populated by admin via PATCH
    disposition:   null,
    analystNotes:  '',
    lastContactAt: null,
  };

  if (!kv) {
    // Graceful degradation — return generated ID even without KV
    // so the session can proceed client-side.
    return json({
      ok:        true,
      caseId,
      createdAt,
      warning:   'CASES KV binding not configured. Case ID generated but not persisted.',
    }, { status: 201 });
  }

  await putCase(kv, caseObj);
  await addToIndex(kv, `case-index:date:${todayKey()}`, caseId);
  await addToIndex(kv, `case-index:status:open`, caseId);

  return json({ ok: true, caseId, createdAt }, { status: 201 });
}

// ─── PATCH /api/cases ─────────────────────────────────────────────────────────
//
// Two callers:
//
//   1. app.js (no auth) — writes score/transcript/evidence at session end
//      Body: { id, score, level, recommendation, matchedFactors, nextSteps,
//              transcript, evidence, status: 'complete' | 'abandoned' }
//
//   2. Admin panel (auth required) — writes disposition/notes/status
//      Body: { id, disposition, analystNotes, lastContactAt, status }

export async function onRequestPatch(context) {
  const { env, request } = context;

  const kv = env?.CASES;
  if (!kv) {
    return json({ error: 'CASES KV binding not configured.' }, { status: 503 });
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { id } = body;
  if (!id) return json({ error: 'id is required.' }, { status: 400 });

  const existing = await getCase(kv, id);
  if (!existing) return json({ error: 'Case not found.' }, { status: 404 });

  // Admin-only fields require the bearer token
  const adminFields     = ['disposition', 'analystNotes', 'lastContactAt'];
  const wantsAdminField = adminFields.some((f) => f in body);
  if (wantsAdminField && !isAuthorized(request, env)) {
    return json({ error: 'Unauthorized — admin token required.' }, { status: 401 });
  }

  const oldStatus = existing.status;
  const updated   = { ...existing, updatedAt: new Date().toISOString() };

  // ── Evaluation fields (written by app.js — no auth) ──
  if ('score'          in body) updated.score          = body.score;
  if ('level'          in body) updated.level          = body.level;
  if ('recommendation' in body) updated.recommendation = body.recommendation;
  if ('matchedFactors' in body) updated.matchedFactors = body.matchedFactors;
  if ('nextSteps'      in body) updated.nextSteps      = body.nextSteps;
  if ('transcript'     in body) updated.transcript     = body.transcript;
  if ('evidence'       in body) updated.evidence       = body.evidence;

  // ── Status transition ──
  if ('status' in body && body.status !== oldStatus) {
    updated.status = body.status;
    await removeFromIndex(kv, `case-index:status:${oldStatus}`, id);
    await addToIndex(kv,      `case-index:status:${body.status}`, id);
  }

  // ── Admin-only fields ──
  if ('disposition'   in body) updated.disposition   = body.disposition;
  if ('analystNotes'  in body) updated.analystNotes  = body.analystNotes;
  if ('lastContactAt' in body) updated.lastContactAt = body.lastContactAt;

  await putCase(kv, updated);

  return json({ ok: true, case: updated });
}
