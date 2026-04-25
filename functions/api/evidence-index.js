/**
 * functions/api/evidence-index.js
 * KASO V1 — Cross-session evidence indexing
 *
 * POST /api/evidence-index
 *   Body: { caseId: 'RXL-...', evidence: [...] }
 *   Builds normalized secondary KV indexes so the same phone/URL/crypto/etc.
 *   submitted in different cases can be matched across cases.
 *
 * GET  /api/evidence-index?caseId=RXL-...
 *   Returns all cross-case matches for the evidence on a given case.
 *   Used by the admin case detail panel to surface coordinated attacks.
 *
 * KV binding: CASES (reuses existing namespace, separate key prefix)
 *
 * Index key schema:
 *   evidence-index:phone:{hash}     → [caseId1, caseId2, ...]
 *   evidence-index:social:{hash}    → [...]
 *   evidence-index:crypto:{hash}    → [...]
 *   evidence-index:url:{hash}       → [...]
 *   evidence-index:msgtype:{type}   → [...]   (plain — not sensitive)
 *
 * Hashing:
 *   Sensitive values (phone, social URL, crypto address, URL) are normalized
 *   then SHA-256 hashed before being used as the index key. Raw values are
 *   never stored in the index — only fingerprints. The case record itself
 *   still holds the readable raw values (encrypted at rest in cases.js).
 */

// ─── AES-256-GCM Decryption (mirrors cases.js) ───────────────────────────────
// We need to decrypt evidence at read time so the indexer can see the
// raw values. Only decryption is needed here — encryption stays in cases.js.

function parseEncryptionKeys(env) {
  try {
    if (!env?.ENCRYPTION_KEYS) return null;
    return JSON.parse(env.ENCRYPTION_KEYS);
  } catch {
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

async function decryptField(encryptedObj, keysObj) {
  if (!encryptedObj?.__encrypted) return encryptedObj;
  if (!keysObj) return null;

  const base64Key = keysObj[encryptedObj.keyVersion];
  if (!base64Key) return null;

  try {
    const key       = await importKey(base64Key);
    const iv        = Uint8Array.from(atob(encryptedObj.iv),   c => c.charCodeAt(0));
    const data      = Uint8Array.from(atob(encryptedObj.data), c => c.charCodeAt(0));
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch {
    return null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function json(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin':  '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'Content-Type, Authorization',
    },
    ...init,
  });
}

function isAuthorized(request, env) {
  const auth     = request.headers.get('authorization') || '';
  const expected = env?.ADMIN_BEARER_TOKEN;
  return expected && auth === `Bearer ${expected}`;
}

// ─── Normalization Functions ──────────────────────────────────────────────────
// Strip formatting differences so the same value in different formats
// produces the same hash. Phone "+1 (555) 123-4567" and "15551234567"
// must produce the same fingerprint.

function normalizePhone(value) {
  if (!value) return null;
  // Strip everything except digits
  const digits = String(value).replace(/\D/g, '');
  if (digits.length < 7) return null;
  // Drop leading 1 for US numbers if 11 digits, keep otherwise
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

function normalizeUrl(value) {
  if (!value) return null;
  let url = String(value).trim().toLowerCase();
  // Strip protocol
  url = url.replace(/^https?:\/\//, '');
  // Strip www.
  url = url.replace(/^www\./, '');
  // Strip trailing slash
  url = url.replace(/\/$/, '');
  // Strip query params and fragments
  url = url.split('?')[0].split('#')[0];
  return url || null;
}

function normalizeSocial(value) {
  if (!value) return null;
  // Same as URL but preserve path (it's the username)
  return normalizeUrl(value);
}

function normalizeCrypto(value) {
  if (!value) return null;
  const v = String(value).trim();
  // ETH addresses are case-insensitive, normalize to lowercase
  if (/^0x[a-fA-F0-9]{40}$/.test(v)) return v.toLowerCase();
  // BTC / other addresses are case-sensitive — preserve
  return v;
}

function normalizeMessageType(value) {
  if (!value) return null;
  return String(value).toLowerCase().trim().replace(/\s+/g, '_');
}

// ─── SHA-256 Hashing ──────────────────────────────────────────────────────────
// One-way fingerprint — same input always produces same output.
// We index by hash so the raw PII is never visible in KV index keys.

async function sha256(input) {
  if (!input) return null;
  const data    = new TextEncoder().encode(String(input));
  const buffer  = await crypto.subtle.digest('SHA-256', data);
  const bytes   = new Uint8Array(buffer);
  // Hex encode — 64 char output
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Extract indexable signals from an evidence item ──────────────────────────

async function signalsFromEvidence(item) {
  const signals = [];
  if (!item?.type) return signals;

  if (item.type === 'phone') {
    const norm = normalizePhone(item.source?.split(':').slice(-1)[0]?.trim() || item.source);
    if (norm) signals.push({ type: 'phone', hash: await sha256(norm), display: item.source });
  }

  if (item.type === 'social') {
    // Source format: "Platform: url"
    const urlPart = item.source?.split(':').slice(1).join(':').trim() || item.source;
    const norm    = normalizeSocial(urlPart);
    if (norm) signals.push({ type: 'social', hash: await sha256(norm), display: item.source });
  }

  if (item.type === 'crypto') {
    // Source format: "N address(es) (CHAIN1, CHAIN2)"
    // The actual addresses are in result.addresses array if present
    const addresses = item.result?.addresses || [];
    for (const a of addresses) {
      const norm = normalizeCrypto(a.address);
      if (norm) signals.push({ type: 'crypto', hash: await sha256(norm), display: `${a.chain}: ${a.address}` });
    }
  }

  if (item.type === 'link') {
    const norm = normalizeUrl(item.source);
    if (norm) signals.push({ type: 'url', hash: await sha256(norm), display: item.source });
  }

  if (item.type === 'message') {
    // Index by scam_type classification (not the message itself — too long, too unique)
    const scamType = item.result?.scam_type;
    if (scamType && scamType !== 'unknown') {
      const norm = normalizeMessageType(scamType);
      if (norm) signals.push({ type: 'msgtype', hash: norm, display: `Pattern: ${scamType}` });
    }
  }

  return signals;
}

// ─── Index Operations ─────────────────────────────────────────────────────────

async function addCaseToIndex(kv, signal, caseId) {
  const key      = `evidence-index:${signal.type}:${signal.hash}`;
  const existing = (await kv.get(key, 'json')) || [];
  if (!existing.includes(caseId)) {
    existing.unshift(caseId);
    await kv.put(key, JSON.stringify(existing));
  }
}

async function lookupCasesForSignal(kv, signal) {
  const key = `evidence-index:${signal.type}:${signal.hash}`;
  return (await kv.get(key, 'json')) || [];
}

// ─── CORS Preflight ───────────────────────────────────────────────────────────

export async function onRequestOptions() {
  return json({ ok: true });
}

// ─── POST /api/evidence-index ─────────────────────────────────────────────────
// Index all evidence on a case. Idempotent — safe to call multiple times.
// Called automatically from cases.js PATCH when evidence is saved.

export async function onRequestPost(context) {
  const { env, request } = context;

  const kv = env?.CASES;
  if (!kv) return json({ error: 'CASES KV binding not configured.' }, { status: 503 });

  let body = {};
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body.' }, { status: 400 }); }

  const { caseId, evidence } = body;
  if (!caseId)                return json({ error: 'caseId is required.' }, { status: 400 });
  if (!Array.isArray(evidence)) return json({ error: 'evidence must be an array.' }, { status: 400 });

  const indexed = [];

  for (const item of evidence) {
    const signals = await signalsFromEvidence(item);
    for (const signal of signals) {
      await addCaseToIndex(kv, signal, caseId);
      indexed.push({ type: signal.type, hash: signal.hash.slice(0, 12) + '...' });
    }
  }

  return json({ ok: true, caseId, indexed: indexed.length, signals: indexed });
}

// ─── GET /api/evidence-index?caseId=RXL-... ───────────────────────────────────
// Returns all cross-case matches for evidence on a given case.
// Used by admin case detail panel.

export async function onRequestGet(context) {
  const { env, request } = context;

  if (!isAuthorized(request, env)) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const kv = env?.CASES;
  if (!kv) return json({ error: 'CASES KV binding not configured.' }, { status: 503 });

  const url    = new URL(request.url);
  const caseId = url.searchParams.get('caseId');
  if (!caseId) return json({ error: 'caseId query param is required.' }, { status: 400 });

  // Load the case to extract its evidence
  const caseObj = await kv.get(`case:${caseId}`, 'json');
  if (!caseObj) return json({ error: 'Case not found.' }, { status: 404 });

  // Decrypt evidence if it's encrypted at rest (matches cases.js)
  const keysObj = parseEncryptionKeys(env);
  let evidence  = caseObj.evidence;
  if (evidence?.__encrypted) {
    evidence = await decryptField(evidence, keysObj);
  }
  if (!Array.isArray(evidence)) evidence = [];

  // For each piece of evidence on this case, look up the index
  const matches = [];

  for (const item of evidence) {
    const signals = await signalsFromEvidence(item);
    for (const signal of signals) {
      const caseIds = await lookupCasesForSignal(kv, signal);
      // Filter out the current case — we want OTHER cases that share this signal
      const otherCases = caseIds.filter(id => id !== caseId);
      if (otherCases.length > 0) {
        matches.push({
          signalType: signal.type,
          display:    signal.display,
          hashPrefix: signal.hash.slice(0, 12) + '...',
          caseCount:  otherCases.length,
          caseIds:    otherCases,
        });
      }
    }
  }

  return json({
    ok:           true,
    caseId,
    matchCount:   matches.length,
    totalSharedCases: new Set(matches.flatMap(m => m.caseIds)).size,
    matches,
  });
}
