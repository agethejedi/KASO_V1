/**
 * functions/api/cluster.js
 * KASO V1 — Attack Cluster aggregation and threat intelligence
 *
 * GET /api/cluster?caseId=RXL-...
 *   Builds a complete attack cluster around the given case.
 *   Returns:
 *     - All cases in the cluster (decrypted)
 *     - Shared signals across the cluster
 *     - Aggregate stats (count, avg score, total exposure, attack span)
 *     - AI-generated threat actor profile
 *
 * Auth: requires ADMIN_BEARER_TOKEN.
 */

// ─── AES-256-GCM Decryption (mirrors cases.js) ────────────────────────────────

function parseEncryptionKeys(env) {
  try {
    if (!env?.ENCRYPTION_KEYS) return null;
    return JSON.parse(env.ENCRYPTION_KEYS);
  } catch { return null; }
}

async function importKey(base64Key) {
  const raw = Uint8Array.from(atob(base64Key), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'raw', raw,
    { name: 'AES-GCM', length: 256 },
    false, ['encrypt', 'decrypt']
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
  } catch { return null; }
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
  if (caseObj.transcript?.__encrypted) d.transcript = await decryptField(caseObj.transcript, keysObj);
  if (caseObj.evidence?.__encrypted)   d.evidence   = await decryptField(caseObj.evidence,   keysObj);
  return d;
}

// ─── Normalization (mirrors evidence-index.js) ────────────────────────────────

function normalizePhone(value) {
  if (!value) return null;
  const digits = String(value).replace(/\D/g, '');
  if (digits.length < 7) return null;
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}
function normalizeUrl(value) {
  if (!value) return null;
  let url = String(value).trim().toLowerCase();
  url = url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').split('?')[0].split('#')[0];
  return url || null;
}
function normalizeCrypto(value) {
  if (!value) return null;
  const v = String(value).trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(v)) return v.toLowerCase();
  return v;
}
function normalizeMessageType(value) {
  if (!value) return null;
  return String(value).toLowerCase().trim().replace(/\s+/g, '_');
}
async function sha256(input) {
  if (!input) return null;
  const data    = new TextEncoder().encode(String(input));
  const buffer  = await crypto.subtle.digest('SHA-256', data);
  const bytes   = new Uint8Array(buffer);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function signalsFromEvidence(item) {
  const signals = [];
  if (!item?.type) return signals;
  if (item.type === 'phone') {
    const norm = normalizePhone(item.source?.split(':').slice(-1)[0]?.trim() || item.source);
    if (norm) signals.push({ type: 'phone', hash: await sha256(norm), display: item.source });
  }
  if (item.type === 'social') {
    const urlPart = item.source?.split(':').slice(1).join(':').trim() || item.source;
    const norm    = normalizeSocial(urlPart);
    if (norm) signals.push({ type: 'social', hash: await sha256(norm), display: item.source });
  }
  if (item.type === 'crypto') {
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
    const scamType = item.result?.scam_type;
    if (scamType && scamType !== 'unknown') {
      const norm = normalizeMessageType(scamType);
      if (norm) signals.push({ type: 'msgtype', hash: norm, display: `Pattern: ${scamType}` });
    }
  }
  return signals;
}

function normalizeSocial(value) { return normalizeUrl(value); }

// ─── General Helpers ──────────────────────────────────────────────────────────

function json(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin':  '*',
      'access-control-allow-methods': 'GET,OPTIONS',
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

// ─── Cluster Aggregation ──────────────────────────────────────────────────────

async function buildCluster(kv, rootCaseId, keysObj) {
  const rootRaw  = await kv.get(`case:${rootCaseId}`, 'json');
  if (!rootRaw) return null;
  const rootCase = await decryptCase(rootRaw, keysObj);

  const rootSignals = [];
  if (Array.isArray(rootCase.evidence)) {
    for (const item of rootCase.evidence) {
      const sigs = await signalsFromEvidence(item);
      rootSignals.push(...sigs);
    }
  }

  const sharedSignals = [];
  const allCaseIds    = new Set([rootCaseId]);

  for (const signal of rootSignals) {
    const indexKey = `evidence-index:${signal.type}:${signal.hash}`;
    const caseIds  = (await kv.get(indexKey, 'json')) || [];
    if (caseIds.length > 1) {
      sharedSignals.push({
        type:      signal.type,
        display:   signal.display,
        matchType: signal.type === 'msgtype' ? 'pattern' : 'exact',
        caseIds:   caseIds,
      });
      caseIds.forEach(id => allCaseIds.add(id));
    }
  }

  const clusterCases = [];
  for (const id of allCaseIds) {
    const raw = await kv.get(`case:${id}`, 'json');
    if (raw) {
      const decrypted = await decryptCase(raw, keysObj);
      clusterCases.push(decrypted);
    }
  }

  clusterCases.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  return { rootCase, clusterCases, sharedSignals };
}

// ─── Cluster Stats ────────────────────────────────────────────────────────────

function computeStats(clusterCases) {
  const scores = clusterCases.filter(c => c.score !== null && c.score !== undefined).map(c => c.score);
  const avgScore = scores.length
    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    : 0;

  // Use structured exposure field — falls back to transcript regex for legacy cases
  let totalExposure   = 0;
  let totalSent       = 0;
  let totalRequested  = 0;
  let totalRecovered  = 0;
  let casesWithExposure = 0;

  for (const c of clusterCases) {
    const exp = c.exposure || {};
    const sent      = typeof exp.sent      === 'number' ? exp.sent      : null;
    const requested = typeof exp.requested === 'number' ? exp.requested : null;
    const recovered = typeof exp.recovered === 'number' ? exp.recovered : null;

    if (sent !== null || requested !== null) {
      casesWithExposure++;
      totalSent      += sent      || 0;
      totalRequested += requested || 0;
      totalRecovered += recovered || 0;
      // Total exposure prefers actual sent amount, falls back to requested
      totalExposure  += sent !== null ? sent : (requested || 0);
      continue;
    }

    // Legacy fallback — transcript regex for cases without structured exposure
    const transcript = Array.isArray(c.transcript) ? c.transcript : [];
    const fullText   = transcript.map(t => t.text || '').join(' ');
    const matches    = fullText.match(/\$[\d,]+(?:\.\d+)?[kKmM]?/g) || [];
    for (const m of matches) {
      let val = m.replace(/[$,]/g, '');
      if (/k$/i.test(val))      val = parseFloat(val) * 1000;
      else if (/m$/i.test(val)) val = parseFloat(val) * 1000000;
      else                       val = parseFloat(val);
      if (val > 100 && val < 10000000) {
        totalExposure += val;
        break;
      }
    }
  }

  const dates = clusterCases.map(c => new Date(c.createdAt)).sort((a, b) => a - b);
  const spanDays = dates.length > 1
    ? Math.ceil((dates[dates.length - 1] - dates[0]) / (1000 * 60 * 60 * 24)) + 1
    : 1;

  return {
    caseCount:        clusterCases.length,
    avgScore,
    totalExposure:    Math.round(totalExposure),
    totalSent:        Math.round(totalSent),
    totalRequested:   Math.round(totalRequested),
    totalRecovered:   Math.round(totalRecovered),
    casesWithExposure,
    exposureSource:   casesWithExposure > 0 ? 'structured' : 'extracted',
    spanDays,
    firstSeen:        dates[0]?.toISOString() || null,
    lastSeen:         dates[dates.length - 1]?.toISOString() || null,
  };
}

// ─── AI Threat Actor Profile ──────────────────────────────────────────────────

async function generateThreatActorProfile(env, clusterCases, sharedSignals, stats) {
  if (!env?.ANTHROPIC_API_KEY) {
    return { available: false, reason: 'Anthropic API key not configured.' };
  }

  const caseSummaries = clusterCases.map(c => {
    const score    = c.score ?? '—';
    const playbook = c.playbook?.name || 'Unknown';
    const date     = (c.createdAt || '').slice(0, 10);
    const evidence = (c.evidence || []).map(e => `${e.type}: ${e.source}`).join('; ');
    return `- ${c.id} | ${date} | ${playbook} | Score ${score} | Evidence: ${evidence || 'none'}`;
  }).join('\n');

  const signalSummary = sharedSignals.map(s =>
    `- ${s.type.toUpperCase()}: ${s.display} (shared across ${s.caseIds.length} cases, ${s.matchType} match)`
  ).join('\n');

  const system = `You are a fraud intelligence analyst building threat actor profiles for law enforcement and bank fraud teams. Produce structured threat profiles based on case clusters with shared evidence.

Respond ONLY with a JSON object, no markdown, no preamble:
{
  "primary_method":           "concise description of the scam type",
  "contact_platform":         "how victims were contacted",
  "financial_method":         "how money was extracted",
  "escalation_pattern":       "how the attack escalates over time, if observable",
  "geographic_spread":        "victim or attacker geography if discernible",
  "key_indicators":           "2-3 most distinctive indicators of this threat actor",
  "law_enforcement_priority": "low|medium|high|critical",
  "recommended_action":       "single-sentence next step recommendation"
}

Be factual. Do not speculate beyond what the data shows. If a field cannot be determined from the cluster data, say "Unknown" or "Insufficient data".`;

  const userMsg = `THREAT ACTOR CLUSTER ANALYSIS

Cluster stats:
- Total cases: ${stats.caseCount}
- Avg risk score: ${stats.avgScore}
- Estimated total exposure: $${stats.totalExposure.toLocaleString()}
- Attack span: ${stats.spanDays} days
- Span: ${stats.firstSeen?.slice(0, 10)} to ${stats.lastSeen?.slice(0, 10)}

Shared signals across cases (this is what links them):
${signalSummary || '- None identified'}

Cases in cluster:
${caseSummaries}

Generate a structured threat actor profile from this cluster.`;

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
        max_tokens: 1000,
        system,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return { available: false, reason: `Anthropic API error: ${resp.status}`, detail: errText };
    }

    const data = await resp.json();
    const raw  = data.content?.find(b => b.type === 'text')?.text || '{}';

    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      return { available: false, reason: 'Could not parse threat profile.', raw };
    }

    return { available: true, ...parsed };
  } catch (err) {
    return { available: false, reason: String(err) };
  }
}

// ─── CORS ─────────────────────────────────────────────────────────────────────

export async function onRequestOptions() {
  return json({ ok: true });
}

// ─── GET /api/cluster?caseId=RXL-... ──────────────────────────────────────────

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

  const keysObj = parseEncryptionKeys(env);
  const cluster = await buildCluster(kv, caseId, keysObj);

  if (!cluster) {
    return json({ error: 'Case not found.' }, { status: 404 });
  }

  if (cluster.clusterCases.length === 1) {
    return json({
      ok:            true,
      isCluster:     false,
      rootCaseId:    caseId,
      cases:         cluster.clusterCases,
      sharedSignals: [],
      stats:         computeStats(cluster.clusterCases),
      threatProfile: { available: false, reason: 'No related cases found — single-case cluster.' },
    });
  }

  const stats         = computeStats(cluster.clusterCases);
  const threatProfile = await generateThreatActorProfile(env, cluster.clusterCases, cluster.sharedSignals, stats);

  return json({
    ok:            true,
    isCluster:     true,
    rootCaseId:    caseId,
    cases:         cluster.clusterCases,
    sharedSignals: cluster.sharedSignals,
    stats,
    threatProfile,
  });
}
