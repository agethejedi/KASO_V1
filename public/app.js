const $ = (id) => document.getElementById(id);
const transcriptEl = $('transcript');
const statusPill = $('statusPill');
const playbookSelect = $('playbookSelect');
const voiceSelect = $('voiceSelect');

let playbooks = [];
let currentPlaybook = null;
let factorIndex = 0;
let answers = {};
let recognition = null;
let recognitionActive = false;
let voices = [];

function appendBubble(text, role = 'agent') {
  const div = document.createElement('div');
  div.className = `bubble ${role}`;
  div.textContent = text;
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function setStatus(text) {
  statusPill.textContent = text;
}

function populateVoices() {
  voices = window.speechSynthesis?.getVoices?.() || [];
  voiceSelect.innerHTML = '';
  voices.forEach((v, idx) => {
    const opt = document.createElement('option');
    opt.value = String(idx);
    opt.textContent = `${v.name} (${v.lang})`;
    voiceSelect.appendChild(opt);
  });
}

function speak(text, onEnd) {
  appendBubble(text, 'agent');
  const utter = new SpeechSynthesisUtterance(text);
  const idx = Number(voiceSelect.value || 0);
  if (voices[idx]) utter.voice = voices[idx];
  utter.rate = 1;
  utter.pitch = 1;
  utter.onend = () => onEnd?.();
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utter);
}

function getCurrentFactor() {
  return currentPlaybook?.factors?.[factorIndex] || null;
}

async function loadPlaybooks() {
  const resp = await fetch('/api/playbooks');
  const data = await resp.json();
  playbooks = data.playbooks || [];
  playbookSelect.innerHTML = '';
  playbooks.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    playbookSelect.appendChild(opt);
  });
  currentPlaybook = playbooks[0] || null;
  $('playbookValue').textContent = currentPlaybook?.name || '—';
}

function initRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    appendBubble('Speech recognition is not supported in this browser. Use Chrome or Edge for the MVP.', 'agent');
    return null;
  }
  const rec = new SR();
  rec.lang = 'en-US';
  rec.interimResults = false;
  rec.maxAlternatives = 1;

  rec.onresult = (event) => {
    const transcript = event.results[0][0].transcript.trim();
    appendBubble(transcript, 'user');
    handleUserAnswer(transcript);
  };

  rec.onerror = (event) => {
    setStatus(`Error: ${event.error}`);
  };

  rec.onend = () => {
    recognitionActive = false;
    if (getCurrentFactor()) setStatus('Ready for next answer');
  };

  return rec;
}

function normalizeYesNo(text) {
  const t = text.toLowerCase();
  if (/\b(yes|yeah|yep|i did|currently|correct|true)\b/.test(t)) return 'yes';
  if (/\b(no|nope|not at all|did not|false)\b/.test(t)) return 'no';
  return 'unsure';
}

function listenForAnswer() {
  if (!recognition) recognition = initRecognition();
  if (!recognition) return;
  if (recognitionActive) return;
  recognitionActive = true;
  setStatus('Listening…');
  recognition.start();
}

function askCurrentQuestion() {
  const factor = getCurrentFactor();
  if (!factor) {
    finishSession();
    return;
  }
  speak(factor.question, () => {
    setTimeout(listenForAnswer, 250);
  });
}

async function finishSession() {
  setStatus('Evaluating');
  speak('Thank you. I am evaluating the responses now.');
  const resp = await fetch('/api/evaluate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playbook: currentPlaybook, answers })
  });
  const result = await resp.json();
  renderDecision(result);
  setStatus('Completed');
}

function renderDecision(result) {
  $('scoreValue').textContent = String(result.score ?? 0);
  $('levelValue').textContent = result.level ? result.level[0].toUpperCase() + result.level.slice(1) : 'Unknown';
  $('levelValue').className = `score-${result.level || 'minimal'}`;
  $('recommendationValue').textContent = result.recommendation || '—';
  $('playbookValue').textContent = currentPlaybook?.name || '—';

  const factorList = $('factorList');
  factorList.innerHTML = '';
  (result.matchedFactors || []).forEach((factor) => {
    const div = document.createElement('div');
    div.className = 'factor-item';
    div.innerHTML = `<strong>${factor.name}</strong><br><small class="helper">Weight: ${factor.weight}. ${factor.resolutionHint || ''}</small>`;
    factorList.appendChild(div);
  });
  if (!result.matchedFactors?.length) {
    factorList.innerHTML = '<div class="factor-item">No factors triggered.</div>';
  }

  const steps = $('nextSteps');
  steps.innerHTML = '';
  (result.nextSteps || []).forEach((step) => {
    const div = document.createElement('div');
    div.className = 'step-item';
    div.textContent = step;
    steps.appendChild(div);
  });
}

function handleUserAnswer(transcript) {
  const factor = getCurrentFactor();
  if (!factor) return;
  const normalized = normalizeYesNo(transcript);
  answers[factor.id] = normalized;

  if (normalized === 'yes' && factor.followUpYes) {
    speak(factor.followUpYes);
  }
  factorIndex += 1;

  const next = getCurrentFactor();
  if (next) {
    setTimeout(askCurrentQuestion, 800);
  } else {
    finishSession();
  }
}

function startSession() {
  currentPlaybook = playbooks.find((p) => p.id === playbookSelect.value) || playbooks[0] || null;
  $('playbookValue').textContent = currentPlaybook?.name || '—';
  transcriptEl.innerHTML = '';
  answers = {};
  factorIndex = 0;
  renderDecision({ score: 0, level: 'minimal', recommendation: 'In progress', matchedFactors: [], nextSteps: [] });
  if (!currentPlaybook) {
    appendBubble('No playbook loaded.', 'agent');
    return;
  }
  setStatus('Starting');
  speak(`Starting the ${currentPlaybook.name} playbook. Please answer yes or no when possible.`, () => {
    setTimeout(askCurrentQuestion, 400);
  });
}

function stopSession() {
  if (recognitionActive && recognition) recognition.stop();
  window.speechSynthesis.cancel();
  setStatus('Stopped');
}

window.speechSynthesis.onvoiceschanged = populateVoices;
$('startBtn').addEventListener('click', startSession);
$('stopBtn').addEventListener('click', stopSession);
playbookSelect.addEventListener('change', () => {
  currentPlaybook = playbooks.find((p) => p.id === playbookSelect.value) || null;
  $('playbookValue').textContent = currentPlaybook?.name || '—';
});

(async function init() {
  await loadPlaybooks();
  populateVoices();
  renderDecision({ score: 0, level: 'minimal', recommendation: 'Not evaluated', matchedFactors: [], nextSteps: [] });
})();
