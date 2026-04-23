/**
 * public/evidence.js
 * Evidence intake panel — link, screenshot, social, crypto analysis.
 * All AI calls go through /api/analyze (Cloudflare Function) which holds
 * the ANTHROPIC_API_KEY server-side. No API key is ever sent to the browser.
 */

(function () {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────────────────
  window.__evidenceLog = [];
  let selectedPlatform = 'Facebook';
  let selectedPhonePlatform = 'WhatsApp';
  let selectedMessageType = 'Text/SMS';
  let cryptoFieldCount = 0;
  const MAX_CRYPTO = 5;

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function $(id) { return document.getElementById(id); }

  function addToLog(type, source, result) {
    window.__evidenceLog.unshift({ type, source, result, at: new Date().toISOString() });
    renderLog();
    const countEl = $('evLogCount');
    if (countEl) countEl.textContent = window.__evidenceLog.length;
  }

  function renderLog() {
    const container = $('evLog');
    if (!container) return;
    if (!window.__evidenceLog.length) {
      container.innerHTML = '<p class="ev-empty">No evidence submitted yet.</p>';
      return;
    }
    container.innerHTML = window.__evidenceLog.map((e) => {
      const v = e.result?.verdict || 'unknown';
      return `
        <div class="ev-log-item ev-log-${v}">
          <div class="ev-log-top">
            <span class="ev-log-type ev-log-type-${e.type}">${e.type.toUpperCase()}</span>
            <span class="ev-log-verdict ev-verdict-${v}">${v.toUpperCase()} · ${e.result?.risk_score ?? '—'}</span>
          </div>
          <div class="ev-log-source">${e.source}</div>
          <div class="ev-log-summary">${e.result?.summary || ''}</div>
        </div>`;
    }).join('');
  }

  // ─── Proxy call to /api/analyze ─────────────────────────────────────────────

  async function analyze(payload) {
    const resp = await fetch('/api/analyze', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Analysis failed.');
    return data.result;
  }

  // ─── Shared UI helpers ───────────────────────────────────────────────────────

  function scanningHTML(source) {
    return `
      <div class="ev-result-header ev-scanning">
        <span class="ev-result-dot"></span>
        <span class="ev-result-status">Scanning…</span>
      </div>
      <div class="ev-result-body">
        <div class="ev-result-source">${source}</div>
        <div class="ev-result-muted">AI analysis in progress…</div>
      </div>`;
  }

  function errorHTML(msg) {
    return `
      <div class="ev-result-header ev-suspicious">
        <span class="ev-result-dot"></span>
        <span class="ev-result-status">Error</span>
      </div>
      <div class="ev-result-body">
        <div class="ev-result-muted">${msg}</div>
      </div>`;
  }

  function findingsHTML(findings) {
    return (findings || []).map((f) =>
      `<div class="ev-finding">
        <span class="ev-finding-dot ev-dot-${f.severity}"></span>
        <span>${f.text}</span>
      </div>`
    ).join('');
  }

  function resultHTML(verdict, score, source, findings, actionHTML) {
    const v = verdict || 'suspicious';
    return `
      <div class="ev-result-header ev-${v}">
        <span class="ev-result-dot"></span>
        <span class="ev-result-status">${v.toUpperCase()}</span>
        <span class="ev-result-score">${score ?? 0}/100</span>
      </div>
      <div class="ev-result-body">
        <div class="ev-result-source">${source}</div>
        <div class="ev-findings">${findingsHTML(findings)}</div>
        ${actionHTML}
      </div>`;
  }

  function actionHTML(verdict) {
    return verdict === 'clean'
      ? `<div class="ev-action ev-action-ok">✓ No immediate threat detected</div>`
      : `<button class="ev-action ev-action-flag">⚑ Flag as evidence</button>`;
  }

  // ─── TABS ───────────────────────────────────────────────────────────────────

  document.querySelectorAll('.ev-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.ev-tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.ev-pane').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      const target = $(tab.dataset.tab);
      if (target) target.classList.add('active');
    });
  });

  // ─── LINK ANALYSIS ──────────────────────────────────────────────────────────

  const analyzeLinkBtn = $('evAnalyzeLinkBtn');
  if (analyzeLinkBtn) {
    analyzeLinkBtn.addEventListener('click', async () => {
      const url = $('evLinkInput').value.trim();
      if (!url) return;

      const resultEl = $('evLinkResult');
      analyzeLinkBtn.disabled = true;
      analyzeLinkBtn.textContent = 'Scanning…';
      resultEl.style.display = 'block';
      resultEl.innerHTML = scanningHTML(url);

      try {
        const r = await analyze({ type: 'link', url });
        resultEl.innerHTML = resultHTML(r.verdict, r.risk_score, url, r.findings, actionHTML(r.verdict));
        addToLog('link', url, r);
      } catch (e) {
        resultEl.innerHTML = errorHTML('Link analysis failed — treat with caution.');
      }

      analyzeLinkBtn.disabled = false;
      analyzeLinkBtn.textContent = 'Analyze';
    });
  }

  // ─── SCREENSHOT ANALYSIS ────────────────────────────────────────────────────

  let currentImageFile = null;

  const fileInput     = $('evFileInput');
  const dropZone      = $('evDropZone');
  const imgPreview    = $('evImgPreview');
  const imgEl         = $('evImgEl');
  const imgClear      = $('evImgClear');
  const analyzeImgBtn = $('evAnalyzeImgBtn');

  function handleImageFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    currentImageFile = file;
    const reader = new FileReader();
    reader.onload = (e) => {
      imgEl.src = e.target.result;
      imgPreview.style.display = 'block';
      analyzeImgBtn.style.display = 'block';
    };
    reader.readAsDataURL(file);
  }

  if (fileInput) fileInput.addEventListener('change', (e) => handleImageFile(e.target.files[0]));

  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      handleImageFile(e.dataTransfer.files[0]);
    });
  }

  if (imgClear) {
    imgClear.addEventListener('click', () => {
      currentImageFile = null;
      imgEl.src = '';
      imgPreview.style.display = 'none';
      analyzeImgBtn.style.display = 'none';
      $('evImgResult').style.display = 'none';
      if (fileInput) fileInput.value = '';
    });
  }

  if (analyzeImgBtn) {
    analyzeImgBtn.addEventListener('click', async () => {
      if (!currentImageFile) return;

      const resultEl = $('evImgResult');
      analyzeImgBtn.disabled = true;
      analyzeImgBtn.textContent = 'Analyzing…';
      resultEl.style.display = 'block';
      resultEl.innerHTML = scanningHTML('Screenshot');

      try {
        // Convert to base64 — the proxy handles the Anthropic vision call
        const imageBase64 = await new Promise((res, rej) => {
          const reader = new FileReader();
          reader.onload  = () => res(reader.result.split(',')[1]);
          reader.onerror = rej;
          reader.readAsDataURL(currentImageFile);
        });

        const r = await analyze({
          type:        'screenshot',
          imageBase64,
          mediaType:   currentImageFile.type || 'image/jpeg',
        });

        const source = r.image_type || 'Screenshot';
        resultEl.innerHTML = resultHTML(r.verdict, r.risk_score, source, r.findings, actionHTML(r.verdict));
        addToLog('screenshot', source, r);

      } catch (e) {
        resultEl.innerHTML = errorHTML('Image analysis failed — describe what you see to the agent.');
      }

      analyzeImgBtn.disabled = false;
      analyzeImgBtn.textContent = 'Analyze screenshot →';
    });
  }

  // ─── SOCIAL MEDIA ANALYSIS ──────────────────────────────────────────────────

  document.querySelectorAll('.ev-platform').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ev-platform').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      selectedPlatform = btn.dataset.platform;
    });
  });

  const analyzeSocialBtn = $('evAnalyzeSocialBtn');
  if (analyzeSocialBtn) {
    analyzeSocialBtn.addEventListener('click', async () => {
      const profileUrl = $('evSocialUrl').value.trim();
      const context    = $('evSocialContext').value.trim();
      if (!profileUrl && !context) return;

      const resultEl = $('evSocialResult');
      analyzeSocialBtn.disabled = true;
      analyzeSocialBtn.textContent = 'Analyzing…';
      resultEl.style.display = 'block';
      resultEl.innerHTML = scanningHTML(profileUrl || 'Social profile');

      try {
        const r = await analyze({
          type:       'social',
          platform:   selectedPlatform,
          profileUrl,
          context,
        });

        const source = `${selectedPlatform}: ${profileUrl || '(no URL)'}`;
        resultEl.innerHTML = resultHTML(r.verdict, r.risk_score, source, r.findings, actionHTML(r.verdict));
        addToLog('social', source, r);

      } catch (e) {
        resultEl.innerHTML = errorHTML('Social analysis failed — describe the interaction to the agent.');
      }

      analyzeSocialBtn.disabled = false;
      analyzeSocialBtn.textContent = 'Analyze profile →';
    });
  }

  // ─── CRYPTO ADDRESS ANALYSIS ────────────────────────────────────────────────

  const CHAIN_PATTERNS = [
    { chain: 'BTC', re: /^(1|3|bc1)[a-zA-HJ-NP-Z0-9]{25,62}$/ },
    { chain: 'ETH', re: /^0x[a-fA-F0-9]{40}$/ },
    { chain: 'XRP', re: /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/ },
    { chain: 'LTC', re: /^[LM3][a-km-zA-HJ-NP-Z1-9]{26,33}$/ },
  ];

  function detectChain(addr) {
    const clean = addr.trim();
    for (const p of CHAIN_PATTERNS) {
      if (p.re.test(clean)) return p.chain;
    }
    if (clean.length >= 25 && clean.length <= 100 && /^[a-zA-Z0-9]+$/.test(clean)) return 'CRYPTO';
    return null;
  }

  function addCryptoField() {
    if (cryptoFieldCount >= MAX_CRYPTO) return;
    cryptoFieldCount++;
    const idx       = cryptoFieldCount;
    const container = $('evCryptoList');
    const row       = document.createElement('div');
    row.className   = 'ev-crypto-row';
    row.id          = `evCryptoRow-${idx}`;
    row.innerHTML   = `
      <span class="ev-crypto-num">0${idx}</span>
      <div class="ev-crypto-wrap">
        <input class="ev-input ev-crypto-input" id="evCryptoAddr-${idx}"
               placeholder="Paste wallet address…"
               oninput="window.__detectCryptoChain(this, ${idx})" />
        <span class="ev-chain-badge" id="evChainBadge-${idx}"></span>
      </div>
      <button class="ev-crypto-remove" onclick="window.__removeCryptoField(${idx})">✕</button>`;
    container.appendChild(row);
    if (cryptoFieldCount >= MAX_CRYPTO) $('evAddCryptoBtn').disabled = true;
  }

  window.__detectCryptoChain = function (input, idx) {
    const badge         = $(`evChainBadge-${idx}`);
    const chain         = detectChain(input.value);
    badge.textContent   = chain || '';
    badge.className     = `ev-chain-badge${chain ? ' ev-chain-show' : ''}`;
  };

  window.__removeCryptoField = function (idx) {
    const row = $(`evCryptoRow-${idx}`);
    if (row) row.remove();
    cryptoFieldCount = Math.max(0, cryptoFieldCount - 1);
    $('evAddCryptoBtn').disabled = false;
  };

  const addCryptoBtn = $('evAddCryptoBtn');
  if (addCryptoBtn) {
    addCryptoBtn.addEventListener('click', addCryptoField);
    addCryptoField(); // seed one field on load
  }

  const analyzeCryptoBtn = $('evAnalyzeCryptoBtn');
  if (analyzeCryptoBtn) {
    analyzeCryptoBtn.addEventListener('click', async () => {
      const addresses = [];
      document.querySelectorAll('.ev-crypto-input').forEach((inp) => {
        const val = inp.value.trim();
        if (val) addresses.push({ address: val, chain: detectChain(val) || 'UNKNOWN' });
      });
      if (!addresses.length) return;

      const resultEl = $('evCryptoResult');
      analyzeCryptoBtn.disabled = true;
      analyzeCryptoBtn.textContent = 'Analyzing…';
      resultEl.style.display = 'block';
      resultEl.innerHTML = scanningHTML(`${addresses.length} address${addresses.length > 1 ? 'es' : ''}`);

      try {
        const r      = await analyze({ type: 'crypto', addresses });
        const source = `${addresses.length} address${addresses.length > 1 ? 'es' : ''} (${addresses.map((a) => a.chain).join(', ')})`;

        // Per-address rows
        const addrRows = (r.addresses || addresses.map((a) => ({
          address: a.address, chain: a.chain, risk: 'medium', finding: 'Analysis complete',
        }))).map((a) => `
          <div class="ev-crypto-result-row">
            <div class="ev-crypto-result-top">
              <span class="ev-chain-badge ev-chain-show">${a.chain}</span>
              <span class="ev-crypto-risk ev-crypto-risk-${a.risk}">${(a.risk || '').toUpperCase()} RISK</span>
            </div>
            <div class="ev-result-source">${a.address}</div>
            <div class="ev-finding-text">${a.finding || ''}</div>
          </div>`).join('');

        resultEl.innerHTML = `
          <div class="ev-result-header ev-${r.verdict || 'suspicious'}">
            <span class="ev-result-dot"></span>
            <span class="ev-result-status">${(r.verdict || 'suspicious').toUpperCase()}</span>
            <span class="ev-result-score">${r.risk_score ?? 0}/100</span>
          </div>
          <div class="ev-result-body">
            ${addrRows}
            <div class="ev-findings">${findingsHTML(r.findings)}</div>
            ${actionHTML(r.verdict)}
          </div>`;

        addToLog('crypto', source, r);

      } catch (e) {
        resultEl.innerHTML = errorHTML('Crypto analysis failed — do not send any funds.');
      }

      analyzeCryptoBtn.disabled = false;
      analyzeCryptoBtn.textContent = 'Analyze addresses →';
    });
  }

  // ─── PHONE + MESSAGE — use event delegation on document body ────────────────
  // Direct listeners fail on hidden panes — delegate from document instead.

  document.addEventListener('click', async (e) => {

    // Phone platform selector
    if (e.target.dataset.phonePlatform) {
      document.querySelectorAll('[data-phone-platform]').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      selectedPhonePlatform = e.target.dataset.phonePlatform;
      return;
    }

    // Message type selector
    if (e.target.dataset.msgType) {
      document.querySelectorAll('[data-msg-type]').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      selectedMessageType = e.target.dataset.msgType;
      return;
    }

    // Phone analyze button
    if (e.target.id === 'evAnalyzePhoneBtn') {
      const btn     = e.target;
      const phone   = $('evPhoneInput')?.value.trim();
      if (!phone) return;

      const resultEl = $('evPhoneResult');
      btn.disabled = true;
      btn.textContent = 'Analyzing…';
      resultEl.style.display = 'block';
      resultEl.innerHTML = scanningHTML(phone);

      try {
        const r = await analyze({ type: 'phone', phone, platform: selectedPhonePlatform });
        const source = `${selectedPhonePlatform}: ${phone}`;
        resultEl.innerHTML = resultHTML(r.verdict, r.risk_score, source, r.findings, actionHTML(r.verdict));
        addToLog('phone', source, r);
      } catch (err) {
        resultEl.innerHTML = errorHTML('Phone analysis failed — note the number manually.');
      }

      btn.disabled = false;
      btn.textContent = 'Analyze';
      return;
    }

    // Message analyze button
    if (e.target.id === 'evAnalyzeMessageBtn') {
      const btn     = e.target;
      const message = $('evMessageInput')?.value.trim();
      if (!message) return;

      const resultEl = $('evMessageResult');
      btn.disabled = true;
      btn.textContent = 'Analyzing…';
      resultEl.style.display = 'block';
      resultEl.innerHTML = scanningHTML('Message');

      try {
        const r = await analyze({ type: 'message', message, messageType: selectedMessageType });
        const preview   = message.slice(0, 60) + (message.length > 60 ? '…' : '');
        const source    = `${selectedMessageType}: "${preview}"`;
        const scamBadge = r.scam_type && r.scam_type !== 'unknown'
          ? `<div style="font-family:var(--mono);font-size:9px;letter-spacing:1px;text-transform:uppercase;color:var(--amber);margin-bottom:8px;">SCAM TYPE: ${r.scam_type.replace('_',' ')}</div>`
          : '';
        const patternsHTML = (r.language_patterns || []).length
          ? `<div style="font-family:var(--mono);font-size:9px;color:var(--text-dim);margin-bottom:8px;">PATTERNS: ${r.language_patterns.join(' · ')}</div>`
          : '';

        resultEl.innerHTML = `
          <div class="ev-result-header ev-${r.verdict || 'suspicious'}">
            <span class="ev-result-dot"></span>
            <span class="ev-result-status">${(r.verdict || 'suspicious').toUpperCase()}</span>
            <span class="ev-result-score">${r.risk_score ?? 0}/100</span>
          </div>
          <div class="ev-result-body">
            <div class="ev-result-source">${source}</div>
            ${scamBadge}
            ${patternsHTML}
            <div class="ev-findings">${findingsHTML(r.findings)}</div>
            ${actionHTML(r.verdict)}
          </div>`;

        addToLog('message', source, r);
      } catch (err) {
        resultEl.innerHTML = errorHTML('Message analysis failed — screenshot the message as an alternative.');
      }

      btn.disabled = false;
      btn.textContent = 'Analyze Message →';
      return;
    }

  });

})();
