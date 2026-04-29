/**
 * functions/api/cases.js
 * KASO V1 — Case management endpoint
 *
 * GET    /api/cases              → list cases (by date or status)
 * GET    /api/cases?id=RXL-...   → single case by ID
 * POST   /api/cases              → create new case
 * PATCH  /api/cases              → update case (score, evidence, transcript, disposition)
 *
 * KV binding: CASES
 *
 * Key schema:
 *   case:{caseId}                        → full case object (JSON)
 *   case-index:date:{YYYY-MM-DD}         → JSON array of caseIds opened that day
 *   case-index:status:{status}           → JSON array of caseIds with that status
 *
 * Encryption: AES-256-GCM field-level encryption on sensitive PII.
 * Keys stored in ENCRYPTION_KEYS Cloudflare secret as versioned JSON:
 *   { "v1": "base64key", "v2": "base64key", ..., "current": "v1" }
 *
 * Encrypted fields:
 *   user.first, user.last, user.email, user.phone
 *   transcript (full array), evidence (full array)
 */

// ─── AES-256-GCM Encryption ───────────────────────────────────────────────────

function parseEncryptionKeys(env) {
  try {
    if (!env?.ENCRYPTION_KEYS) return null;
    return JSON.parse(env.ENCRYPTION_KEYS);
  } catch {
    console.warn('[KASO] ENCRYPTION_KEYS is not valid JSON — encryption disabled.');
    return null;
  }
}

async function importKey(base64Key) {
  const raw = Uint8Array.from(atob(base64Key), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'raw', raw,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptField(value, keysObj) {
  if (!keysObj || value === null || value === undefined) return value;
  const version   = keysObj.current;
  const base64Key = keysObj[version];
  if (!base64Key) return value;

  const key       = await importKey(base64Key);
  const iv        = crypto.getRandomValues(new Uint8Array(12));
  const encoded   = new TextEncoder().encode(JSON.stringify(value));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

  return {
    __encrypted: true,
    keyVersion:  version,
    iv:          btoa(String.fromCharCode(...iv)),
    data:        btoa(String.fromCharCode(...new Uint8Array(encrypted))),
  };
}

async function decryptField(encryptedObj, keysObj) {
  if (!encryptedObj?.__encrypted) return encryptedObj;
  if (!keysObj) return '[ENCRYPTED — key not configured]';

  const base64Key = keysObj[encryptedObj.keyVersion];
  if (!base64Key) return `[ENCRYPTED — key ${encryptedObj.keyVersion} not found]`;

  try {
    const key       = await importKey(base64Key);
    const iv        = Uint8Array.from(atob(encryptedObj.iv),   c => c.charCodeAt(0));
    const data      = Uint8Array.from(atob(encryptedObj.data), c => c.charCodeAt(0));
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch {
    return '[DECRYPTION ERROR]';
  }
}

async function encryptCase(caseObj, keysObj) {
  if (!keysObj) return caseObj;
  const e = { ...caseObj };

  e.user = {
    ...caseObj.user,
    first: await encryptField(caseObj.user?.first, keysObj),
    last:  await encryptField(caseObj.user?.last,  keysObj),
    email: await encryptField(caseObj.user?.email, keysObj),
    phone: await encryptField(caseObj.user?.phone, keysObj),
  };

  if (Array.isArray(caseObj.transcript) && caseObj.transcript.length > 0) {
    e.transcript = await encryptField(caseObj.transcript, keysObj);
  }

  if (Array.isArray(caseObj.evidence) && caseObj.evidence.length > 0) {
    e.evidence = await encryptField(caseObj.evidence, keysObj);
  }

  return e;
}

async function decryptCase(caseObj, keysObj) {
  if (!caseObj) return null;
  const d = { ...caseObj };

  d.user = {
    ...caseObj.user,
    first: await decryptField(caseObj.user?.first, keysObj),
    last:  await decryptField(caseObj.user?.last,  keysObj),
    email: await decryptField(caseObj.user?.email, keysObj),
    phone: await decryptField(caseObj.user?.phone, keysObj),
  };

  if (caseObj.transcript?.__encrypted) {
    d.transcript = await decryptField(caseObj.transcript, keysObj);
  }

  if (caseObj.evidence?.__encrypted) {
    d.evidence = await decryptField(caseObj.evidence, keysObj);
  }

  return d;
}

// ─── General Helpers ──────────────────────────────────────────────────────────

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
  return new Date().toISOString().slice(0, 10);
}

function sanitizeAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(String(value).replace(/[^\d.-]/g, ''));
  if (!isFinite(num) || num < 0) return null;
  return Math.round(num * 100) / 100;
}

function isAuthorized(request, env) {
  const auth     = request.headers.get('authorization') || '';
  const expected = env?.ADMIN_BEARER_TOKEN;
  return expected && auth === `Bearer ${expected}`;
}

// ─── KV Helpers ───────────────────────────────────────────────────────────────

async function getCase(kv, caseId, keysObj) {
  const raw = await kv.get(`case:${caseId}`, 'json');
  return decryptCase(raw, keysObj);
}

async function putCase(kv, caseObj, keysObj) {
  const encrypted = await encryptCase(caseObj, keysObj);
  await kv.put(`case:${caseObj.id}`, JSON.stringify(encrypted));
}

async function addToIndex(kv, indexKey, caseId) {
  const existing = (await kv.get(indexKey, 'json')) || [];
  if (!existing.includes(caseId)) {
    existing.unshift(caseId);
    await kv.put(indexKey, JSON.stringify(existing));
  }
}

async function removeFromIndex(kv, indexKey, caseId) {
  const existing = (await kv.get(indexKey, 'json')) || [];
  await kv.put(indexKey, JSON.stringify(existing.filter(id => id !== caseId)));
}

async function resolveCases(kv, ids, keysObj, limit = 50, offset = 0) {
  const page  = ids.slice(offset, offset + limit);
  const cases = await Promise.all(
    page.map(id =>
      kv.get(`case:${id}`, 'json')
        .then(raw => decryptCase(raw, keysObj))
        .catch(() => null)
    )
  );
  return cases.filter(Boolean);
}

// ─── Evidence merge helper ────────────────────────────────────────────────────
// Merges incoming evidence with existing, deduplicates by type+source+timestamp,
// sorts most recent first. This is the core fix for evidence persistence.

function mergeEvidence(existing = [], incoming = []) {
  if (!Array.isArray(incoming) || incoming.length === 0) return existing;
  if (!Array.isArray(existing)) existing = [];

  const seen   = new Set(existing.map(e => `${e.type}:${e.source}:${e.at}`));
  const merged = [...existing];

  for (const item of incoming) {
    if (!item?.type) continue; // skip malformed items
    const key = `${item.type}:${item.source}:${item.at}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(item);
    }
  }

  // Most recent first
  return merged.sort((a, b) => new Date(b.at) - new Date(a.at));
}

// ─── Transcript merge helper ──────────────────────────────────────────────────
// Merges transcript turns, deduplicates, sorts chronologically.

function mergeTranscript(existing = [], incoming = []) {
  if (!Array.isArray(incoming) || incoming.length === 0) return existing;
  if (!Array.isArray(existing)) existing = [];

  const seen   = new Set(existing.map(t => `${t.at}:${t.role}:${t.text}`));
  const merged = [...existing];

  for (const turn of incoming) {
    if (!turn?.role) continue;
    const key = `${turn.at}:${turn.role}:${turn.text}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(turn);
    }
  }

  return merged.sort((a, b) => new Date(a.at) - new Date(b.at));
}

// ─── CORS Preflight ───────────────────────────────────────────────────────────

export async function onRequestOptions() {
  return json({ ok: true });
}

// ─── GET /api/cases ───────────────────────────────────────────────────────────

export async function onRequestGet(context) {
  const { env, request } = context;

  if (!isAuthorized(request, env)) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const kv = env?.CASES;
  if (!kv) return json({ error: 'CASES KV binding not configured.' }, { status: 503 });

  const keysObj = parseEncryptionKeys(env);
  const url     = new URL(request.url);
  const id      = url.searchParams.get('id');
  const date    = url.searchParams.get('date') || todayKey();
  const status  = url.searchParams.get('status');
  const limit   = Math.min(parseInt(url.searchParams.get('limit')  || '50', 10), 100);
  const offset  = parseInt(url.searchParams.get('offset') || '0', 10);

  if (id) {
    const caseObj = await getCase(kv, id, keysObj);
    if (!caseObj) return json({ error: 'Case not found.' }, { status: 404 });
    return json({ ok: true, case: caseObj });
  }

  if (status) {
    const ids   = (await kv.get(`case-index:status:${status}`, 'json')) || [];
    const cases = await resolveCases(kv, ids, keysObj, limit, offset);
    return json({ ok: true, cases, total: ids.length, limit, offset });
  }

  const ids   = (await kv.get(`case-index:date:${date}`, 'json')) || [];
  const cases = await resolveCases(kv, ids, keysObj, limit, offset);
  return json({ ok: true, cases, date, total: ids.length, limit, offset });
}

// ─── POST /api/cases ──────────────────────────────────────────────────────────

export async function onRequestPost(context) {
  const { env, request } = context;

  const kv = env?.CASES;

  let body = {};
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body.' }, { status: 400 }); }

  const user     = body?.user     || {};
  const playbook = body?.playbook || {};

  if (!user.email || !user.first) {
    return json({ error: 'user.first and user.email are required.' }, { status: 400 });
  }

  const keysObj   = parseEncryptionKeys(env);
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

    score:          null,
    level:          null,
    recommendation: null,
    matchedFactors: [],
    nextSteps:      [],
    transcript:     [],
    evidence:       [],

    // Structured financial exposure tracking
    exposure: {
      requested: null,    // amount the fraudster asked for
      sent:      null,    // amount the victim already sent
      recovered: null,    // amount recovered after incident
      currency:  'USD',
      source:    null,    // 'agent' | 'analyst' | 'extracted' | null
      updatedAt: null,
    },

    disposition:        null,
    analystNotes:       '',
    lastContactAt:      null,
    encryptionVersion:  keysObj?.current || null,
  };

  if (!kv) {
    return json({
      ok:        true,
      caseId,
      createdAt,
      warning:   'CASES KV binding not configured. Case ID generated but not persisted.',
    }, { status: 201 });
  }

  await putCase(kv, caseObj, keysObj);
  await addToIndex(kv, `case-index:date:${todayKey()}`, caseId);
  await addToIndex(kv, `case-index:status:open`, caseId);

  return json({ ok: true, caseId, createdAt }, { status: 201 });
}

// ─── PATCH /api/cases ─────────────────────────────────────────────────────────

export async function onRequestPatch(context) {
  const { env, request } = context;

  const kv = env?.CASES;
  if (!kv) return json({ error: 'CASES KV binding not configured.' }, { status: 503 });

  let body = {};
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body.' }, { status: 400 }); }

  const { id } = body;
  if (!id) return json({ error: 'id is required.' }, { status: 400 });

  const keysObj  = parseEncryptionKeys(env);
  const existing = await getCase(kv, id, keysObj);
  if (!existing) return json({ error: 'Case not found.' }, { status: 404 });

  const adminFields     = ['disposition', 'analystNotes', 'lastContactAt'];
  const wantsAdminField = adminFields.some(f => f in body);
  if (wantsAdminField && !isAuthorized(request, env)) {
    return json({ error: 'Unauthorized — admin token required.' }, { status: 401 });
  }

  const oldStatus = existing.status;
  const updated   = { ...existing, updatedAt: new Date().toISOString() };

  // ── Evaluation fields ──
  if ('score'          in body) updated.score          = body.score;
  if ('level'          in body) updated.level          = body.level;
  if ('recommendation' in body) updated.recommendation = body.recommendation;
  if ('matchedFactors' in body) updated.matchedFactors = body.matchedFactors;
  if ('nextSteps'      in body) updated.nextSteps      = body.nextSteps;

  // ── Exposure — merge sub-fields, preserve existing values when not provided ──
  if ('exposure' in body && body.exposure && typeof body.exposure === 'object') {
    const prev = existing.exposure || {};
    updated.exposure = {
      requested: 'requested' in body.exposure ? sanitizeAmount(body.exposure.requested) : prev.requested ?? null,
      sent:      'sent'      in body.exposure ? sanitizeAmount(body.exposure.sent)      : prev.sent      ?? null,
      recovered: 'recovered' in body.exposure ? sanitizeAmount(body.exposure.recovered) : prev.recovered ?? null,
      currency:  body.exposure.currency || prev.currency || 'USD',
      source:    body.exposure.source   || prev.source   || null,
      updatedAt: new Date().toISOString(),
    };
  }

  // ── Transcript — merge and deduplicate ──
  if ('transcript' in body) {
    updated.transcript = mergeTranscript(
      Array.isArray(existing.transcript) ? existing.transcript : [],
      body.transcript
    );
  }

  // ── Evidence — merge and deduplicate ─────────────────────────────────────────
  // This is the core evidence persistence fix. Incoming evidence is merged
  // with any existing evidence already saved on the case, deduplicated by
  // type + source + timestamp, and sorted most recent first.
  let evidenceChanged = false;
  if ('evidence' in body) {
    updated.evidence = mergeEvidence(
      Array.isArray(existing.evidence) ? existing.evidence : [],
      body.evidence
    );
    evidenceChanged = true;
  }

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

  // Track current encryption version
  updated.encryptionVersion = keysObj?.current || existing.encryptionVersion || null;

  await putCase(kv, updated, keysObj);

  // ── Cross-session evidence indexing ─────────────────────────────────────────
  // When evidence changes, index it for cross-case matching.
  // Non-blocking — indexing failure should not block the case save.
  if (evidenceChanged && Array.isArray(updated.evidence) && updated.evidence.length > 0) {
    try {
      const indexUrl = new URL('/api/evidence-index', request.url).toString();
      await fetch(indexUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseId:   id,
          evidence: updated.evidence,
        }),
      });
    } catch (err) {
      console.warn('[KASO] Evidence indexing failed (non-blocking):', err);
    }
  }

  return json({ ok: true, case: updated });
}
