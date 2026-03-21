const $ = (id) => document.getElementById(id);
const editorWrap = $('factorEditors');
const predefinedSelect = $('predefinedFactorSelect');
const playbookSelect = $('adminPlaybookSelect');
const adminMessage = $('adminMessage');

let state = { version: 1, playbooks: [] };
let currentPlaybook = null;

function uniqueId(prefix = 'custom') {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function allPredefinedFactors() {
  const map = new Map();
  for (const p of state.playbooks) {
    for (const f of p.factors || []) {
      if (f.type === 'predefined' && !map.has(f.id)) map.set(f.id, structuredClone(f));
    }
  }
  return Array.from(map.values());
}

function loadPlaybookIntoForm() {
  if (!currentPlaybook) return;
  $('playbookName').value = currentPlaybook.name || '';
  $('playbookDescription').value = currentPlaybook.description || '';
  $('thresholdLow').value = currentPlaybook.thresholds?.low ?? 20;
  $('thresholdModerate').value = currentPlaybook.thresholds?.moderate ?? 40;
  $('thresholdHigh').value = currentPlaybook.thresholds?.high ?? 60;
  renderFactorEditors();
}

function renderFactorEditors() {
  editorWrap.innerHTML = '';
  (currentPlaybook.factors || []).forEach((factor) => {
    const div = document.createElement('div');
    div.className = 'factor-editor stack';
    div.innerHTML = `
      <div class="split">
        <div>
          <label>Name</label>
          <input data-field="name" value="${escapeHtml(factor.name || '')}" />
        </div>
        <div>
          <label>Weight</label>
          <input data-field="weight" type="number" value="${escapeHtml(String(factor.weight || 0))}" />
        </div>
      </div>
      <div>
        <label>Question</label>
        <input data-field="question" value="${escapeHtml(factor.question || '')}" />
      </div>
      <div>
        <label>Follow-up if yes</label>
        <input data-field="followUpYes" value="${escapeHtml(factor.followUpYes || '')}" />
      </div>
      <div>
        <label>Resolution hint</label>
        <input data-field="resolutionHint" value="${escapeHtml(factor.resolutionHint || '')}" />
      </div>
      <div class="row">
        <span class="status-pill">${factor.type || 'custom'}</span>
        <button type="button" class="btn-secondary" data-action="remove">Remove</button>
      </div>
    `;

    div.querySelectorAll('input').forEach((input) => {
      input.addEventListener('input', () => {
        factor[input.dataset.field] = input.type === 'number' ? Number(input.value) : input.value;
      });
    });
    div.querySelector('[data-action="remove"]').addEventListener('click', () => {
      currentPlaybook.factors = currentPlaybook.factors.filter((f) => f.id !== factor.id);
      renderFactorEditors();
    });
    editorWrap.appendChild(div);
  });
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderPredefinedOptions() {
  predefinedSelect.innerHTML = '';
  allPredefinedFactors().forEach((factor) => {
    const opt = document.createElement('option');
    opt.value = factor.id;
    opt.textContent = `${factor.name} (+${factor.weight})`;
    predefinedSelect.appendChild(opt);
  });
}

function renderPlaybookOptions() {
  playbookSelect.innerHTML = '';
  state.playbooks.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    playbookSelect.appendChild(opt);
  });
  currentPlaybook = state.playbooks.find((p) => p.id === playbookSelect.value) || state.playbooks[0] || null;
  if (currentPlaybook) playbookSelect.value = currentPlaybook.id;
  loadPlaybookIntoForm();
}

async function loadState() {
  const resp = await fetch('/api/playbooks');
  state = await resp.json();
  renderPredefinedOptions();
  renderPlaybookOptions();
}

function syncPlaybookHeaderFields() {
  if (!currentPlaybook) return;
  currentPlaybook.name = $('playbookName').value;
  currentPlaybook.description = $('playbookDescription').value;
  currentPlaybook.thresholds = {
    low: Number($('thresholdLow').value || 20),
    moderate: Number($('thresholdModerate').value || 40),
    high: Number($('thresholdHigh').value || 60)
  };
}

$('playbookName').addEventListener('input', syncPlaybookHeaderFields);
$('playbookDescription').addEventListener('input', syncPlaybookHeaderFields);
$('thresholdLow').addEventListener('input', syncPlaybookHeaderFields);
$('thresholdModerate').addEventListener('input', syncPlaybookHeaderFields);
$('thresholdHigh').addEventListener('input', syncPlaybookHeaderFields);

playbookSelect.addEventListener('change', () => {
  currentPlaybook = state.playbooks.find((p) => p.id === playbookSelect.value) || null;
  loadPlaybookIntoForm();
});

$('addPredefinedBtn').addEventListener('click', () => {
  const factor = allPredefinedFactors().find((f) => f.id === predefinedSelect.value);
  if (!factor || !currentPlaybook) return;
  const copy = structuredClone(factor);
  copy.id = uniqueId(factor.id);
  currentPlaybook.factors.push(copy);
  renderFactorEditors();
});

$('addCustomBtn').addEventListener('click', () => {
  if (!currentPlaybook) return;
  const name = $('customName').value.trim();
  const question = $('customQuestion').value.trim();
  const weight = Number($('customWeight').value || 20);
  const hint = $('customHint').value.trim();
  if (!name || !question) {
    adminMessage.textContent = 'Custom factor needs at least a name and question.';
    return;
  }
  currentPlaybook.factors.push({
    id: uniqueId('custom'),
    name,
    type: 'custom',
    weight,
    question,
    followUpYes: '',
    resolutionHint: hint
  });
  $('customName').value = '';
  $('customQuestion').value = '';
  $('customHint').value = '';
  $('customWeight').value = '20';
  renderFactorEditors();
});

$('saveBtn').addEventListener('click', async () => {
  syncPlaybookHeaderFields();
  const token = $('adminToken').value.trim();
  if (!token) {
    adminMessage.textContent = 'Admin bearer token is required to save.';
    return;
  }
  state.version = Date.now();
  const resp = await fetch('/api/playbooks', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(state)
  });
  const result = await resp.json();
  if (!resp.ok) {
    adminMessage.textContent = result.error || 'Save failed.';
    return;
  }
  adminMessage.textContent = result.warning || 'Saved successfully.';
});

$('resetBtn').addEventListener('click', loadState);

loadState();
