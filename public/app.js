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

// Voice loop guards
let isSpeaking = false;
let sessionActive = false;
let awaitingAnswer = false;
let lastSpokenText = '';
let suppressRecognitionUntil = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function stopListening() {
  if (!recognition || !recognitionActive) return;
  try {
    recognition.stop();
  } catch (err) {
    console.warn('Recognition stop failed:', err);
  }
}

function stopSpeaking() {
  try {
    window.speechSynthesis.cancel();
  } catch (err) {
    console.warn('speechSynthesis.cancel failed:', err);
  }
  isSpeaking = false;
}

function speak(text, options = {}) {
  const { logBubble = true, preDelay = 120, postDelay = 450 } = options;

  return new Promise(async (resolve) => {
    if (!text) {
      resolve();
      return;
    }

    stopListening();

    if (logBubble) {
      appendBubble(text, 'agent');
    }

    if (!window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') {
      await sleep(postDelay);
      resolve();
      return;
    }

    try {
      window.speechSynthesis.cancel();
    } catch (err) {
      console.warn('speechSynthesis.cancel failed:', err);
    }

    await sleep(preDelay);

    const utter = new SpeechSynthesisUtterance(text);
    const idx = Number(voiceSelect.value || 0);
    if (voices[idx]) utter.voice = voices[idx];
    utter.rate = 1;
    utter.pitch = 1;

    isSpeaking = true;
    lastSpokenText = text;
    suppressRecognitionUntil = Date.now() + preDelay + postDelay + 300;

    utter.onend = async () => {
      isSpeaking = false;
      await sleep(postDelay);
      resolve();
    };

    utter.onerror = async (event) => {
      console.warn('Speech synthesis error:', event);
      isSpeaking = false;
      await sleep(postDelay);
      resolve();
    };

    try {
      window.speechSynthesis.speak(utter);
    } catch (err) {
      console.warn('speechSynthesis.speak failed:', err);
      isSpeaking = false;
      await sleep(postDelay);
      resolve();
    }
  });
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
  rec.continuous = false;

  rec.onresult = async (event) => {
    const transcript = event.results?.[0]?.[0]?.transcript?.trim();
    if (!transcript) return;

    recognitionActive = false;

    // Ignore anything captured while app is still talking or during suppression window
    if (isSpeaking || Date.now() < suppressRecognitionUntil) {
      return;
    }

    appendBubble(transcript, 'user');
    awaitingAnswer = false;
    await handleUserAnswer(transcript);
  };

  rec.onerror = (event) => {
    recognitionActive = false;

    // Ignore noisy/expected errors while transitioning between speech and listening
    if (event.error === 'aborted' || event.error === 'no-speech') {
      setStatus('Ready');
      return;
    }

    setStatus(`Error: ${event.error}`);
  };

  rec.onend = () => {
    recognitionActive = false;
    if (sessionActive && awaitingAnswer && !isSpeaking) {
      setStatus('Ready for next answer');
    }
  };

  return rec;
}

function normalizeYesNo(text) {
  const t = text.toLowerCase();
  if (/\b(yes|yeah|yep|i did|currently|correct|true|affirmative|sure)\b/.test(t)) return 'yes';
  if (/\b(no|nope|not at all|did not|false|negative)\b/.test(t)) return 'no';
  return 'unsure';
}

function listenForAnswer() {
  if (!sessionActive) return;
  if (isSpeaking) return;

  if (!recognition) recognition = initRecognition();
  if (!recognition) return;
  if (recognitionActive) return;

  try {
    recognitionActive = true;
    awaitingAnswer = true;
    setStatus('Listening…');
    recognition.start();
  } catch (err) {
    recognitionActive = false;
    console.warn('Recognition start failed:', err);
    setStatus('Mic unavailable');
  }
}

async function askCurrentQuestion() {
  const factor = getCurrentFactor();
  if (!factor) {
    await finishSession();
    return;
  }

  awaitingAnswer = false;
  await speak(factor.question);
  if (!sessionActive) return;
  listenForAnswer();
}

async function finishSession() {
  sessionActive = false;
  awaitingAnswer = false;
  stopListening();

  setStatus('Evaluating');
  await speak('Thank you. I am evaluating the responses now.');

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

async function handleUserAnswer(transcript) {
  const factor = getCurrentFactor();
  if (!factor || !sessionActive) return;

  const normalized = normalizeYesNo(transcript);
  answers[factor.id] = normalized;

  if (normalized === 'yes' && factor.followUpYes) {
    await speak(factor.followUpYes);
    if (!sessionActive) return;
  }

  factorIndex += 1;

  const next = getCurrentFactor();
  if (next) {
    await sleep(250);
    await askCurrentQuestion();
  } else {
    await finishSession();
  }
}

async function startSession() {
  stopSession({ silent: true });

  currentPlaybook = playbooks.find((p) => p.id === playbookSelect.value) || playbooks[0] || null;
  $('playbookValue').textContent = currentPlaybook?.name || '—';
  transcriptEl.innerHTML = '';
  answers = {};
  factorIndex = 0;
  sessionActive = true;
  awaitingAnswer = false;
  renderDecision({
    score: 0,
    level: 'minimal',
    recommendation: 'In progress',
    matchedFactors: [],
    nextSteps: []
  });

  if (!currentPlaybook) {
    appendBubble('No playbook loaded.', 'agent');
    setStatus('No playbook loaded');
    return;
  }

  setStatus('Starting');
  await speak(`Starting the ${currentPlaybook.name} playbook. Please answer yes or no when possible.`);
  if (!sessionActive) return;

  await sleep(200);
  await askCurrentQuestion();
}

function stopSession(options = {}) {
  const { silent = false } = options;
  sessionActive = false;
  awaitingAnswer = false;
  stopListening();
  stopSpeaking();
  if (!silent) {
    setStatus('Stopped');
  }
}

window.speechSynthesis.onvoiceschanged = populateVoices;
$('startBtn').addEventListener('click', () => {
  startSession().catch((err) => {
    console.error('Start session failed:', err);
    setStatus('Start failed');
  });
});
$('stopBtn').addEventListener('click', () => stopSession());

playbookSelect.addEventListener('change', () => {
  currentPlaybook = playbooks.find((p) => p.id === playbookSelect.value) || null;
  $('playbookValue').textContent = currentPlaybook?.name || '—';
});

(async function init() {
  await loadPlaybooks();
  populateVoices();
  renderDecision({
    score: 0,
    level: 'minimal',
    recommendation: 'Not evaluated',
    matchedFactors: [],
    nextSteps: []
  });
})();
