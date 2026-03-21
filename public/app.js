const $ = (id) => document.getElementById(id);
const transcriptEl = $('transcript');
const statusPill = $('statusPill');
const modePill = $('modePill');
const playbookSelect = $('playbookSelect');
const voiceSelect = $('voiceSelect');
const voiceModeSelect = $('voiceModeSelect');
const currentQuestionEl = $('currentQuestion');
const manualAnswerInput = $('manualAnswerInput');
const guidedAnswerCard = $('guidedAnswerCard');
const micHeadline = $('micHeadline');
const micSubtext = $('micSubtext');
const riskStateValue = $('riskStateValue');
const customerStateValue = $('customerStateValue');
const narrativeValue = $('narrativeValue');
const reasoningList = $('reasoningList');
const coercionList = $('coercionList');
const stressList = $('stressList');
const followUpList = $('followUpList');

let playbooks = [];
let currentPlaybook = null;
let factorIndex = 0;
let answers = {};
let recognition = null;
let recognitionActive = false;
let voices = [];
let sessionActive = false;
let awaitingAnswer = false;
let isSpeaking = false;
let suppressRecognitionUntil = 0;
let transcriptLog = [];
let audioCtx = null;
let realtimeState = {
  pc: null,
  dc: null,
  stream: null,
  remoteAudio: null,
  sessionOpen: false,
  assistantBuffer: '',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function selectedMode() {
  return voiceModeSelect.value || 'guided';
}

function appendBubble(text, role = 'agent') {
  if (!text) return;
  const div = document.createElement('div');
  div.className = `bubble ${role}`;
  div.textContent = text;
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  transcriptLog.push({ role, text, at: new Date().toISOString() });
}

function setStatus(text) {
  statusPill.textContent = text;
}

function setMicState(state, headline, subtext) {
  document.body.dataset.micState = state;
  if (headline) micHeadline.textContent = headline;
  if (subtext) micSubtext.textContent = subtext;
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

function renderModeUI() {
  const guided = selectedMode() === 'guided';
  guidedAnswerCard.style.display = guided ? 'grid' : 'none';
  modePill.textContent = guided ? 'Guided' : 'Realtime';
  currentQuestionEl.textContent = guided ? 'Not started.' : 'Realtime agent will guide the interview, adapt questions, and probe for coercion or stress.';
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

async function playListeningCue() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.value = 0.0001;
    const now = audioCtx.currentTime;
    gain.gain.exponentialRampToValueAtTime(0.04, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    osc.start(now);
    osc.stop(now + 0.12);
  } catch (err) {
    console.warn('Listening cue unavailable:', err);
  }
}

function speak(text, options = {}) {
  const { logBubble = true, preDelay = 120, postDelay = 420 } = options;
  return new Promise(async (resolve) => {
    if (!text) return resolve();
    stopListening();
    if (logBubble) appendBubble(text, 'agent');
    if (!window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') {
      await sleep(postDelay);
      return resolve();
    }
    try { window.speechSynthesis.cancel(); } catch {}
    await sleep(preDelay);
    const utter = new SpeechSynthesisUtterance(text);
    const idx = Number(voiceSelect.value || 0);
    if (voices[idx]) utter.voice = voices[idx];
    utter.rate = 1;
    utter.pitch = 1;
    isSpeaking = true;
    setMicState('speaking', 'Agent speaking', 'Please wait for the tone or listening state before answering.');
    suppressRecognitionUntil = Date.now() + preDelay + postDelay + 400;
    utter.onend = async () => {
      isSpeaking = false;
      await sleep(postDelay);
      resolve();
    };
    utter.onerror = async () => {
      isSpeaking = false;
      await sleep(postDelay);
      resolve();
    };
    try {
      window.speechSynthesis.speak(utter);
    } catch {
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
    appendBubble('Speech recognition is not supported in this browser. Use quick buttons, typed fallback, or switch to OpenAI Realtime.', 'system');
    return null;
  }
  const rec = new SR();
  rec.lang = 'en-US';
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.continuous = false;

  rec.onresult = async (event) => {
    const transcript = event.results?.[0]?.[0]?.transcript?.trim();
    recognitionActive = false;
    if (!transcript) return;
    if (isSpeaking || Date.now() < suppressRecognitionUntil) return;
    appendBubble(transcript, 'user');
    awaitingAnswer = false;
    manualAnswerInput.value = '';
    await handleUserAnswer(transcript);
  };

  rec.onerror = async (event) => {
    recognitionActive = false;
    if (!sessionActive || selectedMode() !== 'guided') return;
    if (event.error === 'aborted') return;
    if (event.error === 'no-speech') {
      setStatus('No speech detected');
      setMicState('connected', 'No speech detected', 'You can answer again, tap a quick button, or type your answer.');
      awaitingAnswer = true;
      return;
    }
    setStatus(`Error: ${event.error}`);
    setMicState('error', 'Microphone issue', 'Use quick buttons or typed fallback if microphone capture is inconsistent.');
  };

  rec.onend = () => {
    recognitionActive = false;
    if (sessionActive && awaitingAnswer && !isSpeaking && selectedMode() === 'guided') {
      setStatus('Ready');
      setMicState('connected', 'Ready for your answer', 'You can speak now, use a quick button, or type a fallback answer.');
    }
  };
  return rec;
}

function normalizeYesNo(text) {
  const t = text.toLowerCase();
  if (/(yes|yeah|yep|i did|currently|correct|true|affirmative|sure|that happened|it did)/.test(t)) return 'yes';
  if (/(no|nope|not at all|did not|false|negative|never|it did not|don't think so)/.test(t)) return 'no';
  return 'unsure';
}

async function listenForAnswer() {
  if (!sessionActive || selectedMode() !== 'guided') return;
  if (isSpeaking) return;
  if (!recognition) recognition = initRecognition();
  if (!recognition) return;
  if (recognitionActive) return;
  try {
    recognitionActive = true;
    awaitingAnswer = true;
    setStatus('Listening…');
    setMicState('listening', 'Listening', 'Answer after the tone. Quick buttons and typed fallback stay available.');
    await playListeningCue();
    await sleep(120);
    recognition.start();
  } catch (err) {
    recognitionActive = false;
    console.warn('Recognition start failed:', err);
    setStatus('Mic unavailable');
    setMicState('error', 'Microphone unavailable', 'Use quick buttons or switch to OpenAI Realtime voice.');
  }
}

async function askCurrentQuestion() {
  const factor = getCurrentFactor();
  if (!factor) {
    await finishSession();
    return;
  }
  currentQuestionEl.textContent = factor.question;
  awaitingAnswer = false;
  await speak(factor.question);
  if (!sessionActive) return;
  await listenForAnswer();
}

async function evaluateCurrentSession() {
  const payload = {
    playbook: currentPlaybook,
    answers,
    transcriptText: transcriptLog.map((entry) => `${entry.role}: ${entry.text}`).join('\n')
  };
  const resp = await fetch('/api/evaluate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const result = await resp.json();
  renderDecision(result);
  return result;
}

async function finishSession() {
  sessionActive = false;
  awaitingAnswer = false;
  stopListening();
  setStatus('Evaluating');
  setMicState('connected', 'Evaluating', 'Scoring the interview and generating next steps.');
  if (selectedMode() === 'guided') {
    await speak('Thank you. I am evaluating the responses now.');
  }
  await evaluateCurrentSession();
  setStatus('Completed');
  setMicState('connected', 'Session completed', 'Review the scorecard and next steps.');
}

function renderDecision(result) {
  $('scoreValue').textContent = String(result.score ?? 0);
  $('levelValue').textContent = result.level ? result.level[0].toUpperCase() + result.level.slice(1) : 'Unknown';
  $('levelValue').className = `score-${result.level || 'minimal'}`;
  $('recommendationValue').textContent = result.recommendation || '—';
  $('playbookValue').textContent = currentPlaybook?.name || '—';
  if (riskStateValue) riskStateValue.textContent = result.riskState || '—';
  if (customerStateValue) customerStateValue.textContent = result.customerState || '—';
  if (narrativeValue) narrativeValue.textContent = result.narrative || 'No case narrative generated yet.';

  const factorList = $('factorList');
  factorList.innerHTML = '';
  (result.matchedFactors || []).forEach((factor) => {
    const div = document.createElement('div');
    div.className = 'factor-item';
    div.innerHTML = `<strong>${factor.name}</strong><br><small class="helper">Weight: ${factor.weight}. ${factor.resolutionHint || ''}</small>`;
    factorList.appendChild(div);
  });
  if (!result.matchedFactors?.length) factorList.innerHTML = '<div class="factor-item">No factors triggered.</div>';

  const steps = $('nextSteps');
  steps.innerHTML = '';
  (result.nextSteps || []).forEach((step) => {
    const div = document.createElement('div');
    div.className = 'step-item';
    div.textContent = step;
    steps.appendChild(div);
  });
  if (!result.nextSteps?.length) {
    steps.innerHTML = '<div class="step-item">No next steps generated.</div>';
  }

  if (reasoningList) {
    reasoningList.innerHTML = '';
    (result.reasoningSummary || []).forEach((item) => {
      const div = document.createElement('div');
      div.className = 'step-item';
      div.textContent = item;
      reasoningList.appendChild(div);
    });
    if (!result.reasoningSummary?.length) {
      reasoningList.innerHTML = '<div class="step-item">No reasoning summary yet.</div>';
    }
  }

  if (coercionList) {
    coercionList.innerHTML = '';
    (result.coercionSignals || []).forEach((signal) => {
      const div = document.createElement('div');
      div.className = 'step-item';
      div.innerHTML = `<strong>${signal.label}</strong><br><small class="helper">${signal.explanation}</small>`;
      coercionList.appendChild(div);
    });
    if (!result.coercionSignals?.length) {
      coercionList.innerHTML = '<div class="step-item">No coercion indicators detected.</div>';
    }
  }

  if (stressList) {
    stressList.innerHTML = '';
    (result.stressSignals || []).forEach((signal) => {
      const div = document.createElement('div');
      div.className = 'step-item';
      div.innerHTML = `<strong>${signal.label}</strong><br><small class="helper">${signal.explanation}</small>`;
      stressList.appendChild(div);
    });
    if (!result.stressSignals?.length) {
      stressList.innerHTML = '<div class="step-item">No stress indicators detected.</div>';
    }
  }

  if (followUpList) {
    followUpList.innerHTML = '';
    (result.recommendedFollowUps || []).forEach((question) => {
      const div = document.createElement('div');
      div.className = 'step-item';
      div.textContent = question;
      followUpList.appendChild(div);
    });
    if (!result.recommendedFollowUps?.length) {
      followUpList.innerHTML = '<div class="step-item">No follow-up questions suggested.</div>';
    }
  }
}

async function handleUserAnswer(transcript, forced = null) {
  const factor = getCurrentFactor();
  if (!factor || !sessionActive) return;
  const normalized = forced || normalizeYesNo(transcript);
  answers[factor.id] = normalized;
  markQuickAnswer(normalized);
  if (normalized === 'yes' && factor.followUpYes) {
    await speak(factor.followUpYes);
    if (!sessionActive) return;
  }
  if (normalized === 'unsure' && factor.followUpUnsure) {
    await speak(factor.followUpUnsure);
    if (!sessionActive) return;
  }
  factorIndex += 1;
  const next = getCurrentFactor();
  if (next) {
    await sleep(220);
    await askCurrentQuestion();
  } else {
    await finishSession();
  }
}

function markQuickAnswer(value) {
  document.querySelectorAll('.quick-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.answer === value);
  });
}

function buildRealtimeInstructions(playbook) {
  const factorGuidance = (playbook?.factors || []).map((factor, idx) => {
    const cues = Array.isArray(factor.positiveCues) && factor.positiveCues.length
      ? ` Positive cues include: ${factor.positiveCues.join(', ')}.`
      : '';
    const unsureCue = factor.followUpUnsure ? ` If the client is unsure, use this style of probe: ${factor.followUpUnsure}` : '';
    return `${idx + 1}. ${factor.name}: ask about ${factor.question}${cues}${unsureCue} Weight ${factor.weight}.`;
  }).join('\n');

  const hardStops = (playbook?.hardStops || []).length
    ? `Hard stop patterns: ${(playbook.hardStops || []).join('; ')}.`
    : '';

  return [
    `You are a fraud response voice agent for the playbook: ${playbook?.name || 'Fraud review'}.`,
    'Interview the client in a calm, concise, banking-safe manner.',
    'Ask one question at a time. Adapt based on what the client says. Clarify when the answer is partial, hesitant, contradictory, rushed, or indicates coaching.',
    'Reason out loud only in short customer-safe language. Do not expose scoring, internal weights, or internal policy thresholds.',
    'Actively probe for coercion, urgency, secrecy, fear, confusion, hesitation, contradiction, or someone feeding the client answers in real time.',
    'If the client sounds coached, uncertain, or distressed, slow down, acknowledge the pressure, and ask the client to explain events in their own words.',
    'Prioritize urgent containment if you hear remote access, live coaching, changed wire instructions, urgency, secrecy, or instructions to move money for safety.',
    'Do not approve or deny a transaction yourself. Gather facts, explain risk plainly, and end with a short summary plus recommended next steps.',
    hardStops,
    'Use the playbook factors below to guide questioning:',
    factorGuidance,
  ].filter(Boolean).join('\n\n');
}

async function startRealtimeSession() {
  const playbook = currentPlaybook;
  if (!playbook) {
    appendBubble('No playbook loaded.', 'system');
    return;
  }
  setStatus('Connecting…');
  setMicState('connected', 'Connecting to OpenAI Realtime', 'Requesting a session token and preparing live voice.');
  appendBubble('Connecting to OpenAI Realtime voice…', 'system');

  const tokenResp = await fetch('/api/realtime-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      playbookId: playbook.id,
      instructions: buildRealtimeInstructions(playbook),
    })
  });
  const tokenData = await tokenResp.json();
  if (!tokenResp.ok || !tokenData.value) {
    appendBubble(tokenData.error || 'Realtime session could not be created. Configure OPENAI_API_KEY to enable this mode.', 'system');
    setStatus('Realtime unavailable');
    setMicState('error', 'Realtime unavailable', 'Check the OpenAI secret in Cloudflare or use guided mode.');
    return;
  }

  const pc = new RTCPeerConnection();
  const remoteAudio = document.createElement('audio');
  remoteAudio.autoplay = true;
  pc.ontrack = (event) => { remoteAudio.srcObject = event.streams[0]; };

  const localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  const dc = pc.createDataChannel('oai-events');
  dc.addEventListener('open', () => {
    realtimeState.sessionOpen = true;
    setStatus('Realtime live');
    setMicState('connected', 'Realtime connected', 'You can talk naturally. The agent will adapt based on the client response.');
    const initialMessage = {
      type: 'response.create',
      response: {
        instructions: `Begin the ${playbook.name} interview now. Greet the client briefly, explain that you will ask a few questions for fraud protection, and then ask the first question.`,
      },
    };
    dc.send(JSON.stringify(initialMessage));
  });

  dc.addEventListener('message', (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    handleRealtimeEvent(payload);
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const sdpResp = await fetch('https://api.openai.com/v1/realtime/calls', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenData.value}`,
      'Content-Type': 'application/sdp'
    },
    body: offer.sdp
  });
  if (!sdpResp.ok) {
    const errText = await sdpResp.text();
    appendBubble(`Realtime connection failed: ${errText}`, 'system');
    setStatus('Realtime failed');
    setMicState('error', 'Realtime failed', 'Switch back to guided mode or check your OpenAI settings.');
    localStream.getTracks().forEach((t) => t.stop());
    pc.close();
    return;
  }
  const answer = { type: 'answer', sdp: await sdpResp.text() };
  await pc.setRemoteDescription(answer);
  realtimeState = { pc, dc, stream: localStream, remoteAudio, sessionOpen: true, assistantBuffer: '' };
}

function handleRealtimeEvent(event) {
  if (!event?.type) return;
  if (event.type === 'output_audio_buffer.started' || event.type === 'response.audio.delta') {
    setMicState('speaking', 'Agent speaking', 'OpenAI voice is responding. Wait for a natural pause before interrupting.');
    return;
  }
  if (event.type === 'output_audio_buffer.stopped' || event.type === 'response.audio.done') {
    setMicState('connected', 'Realtime connected', 'The agent is ready for the next client response.');
    return;
  }
  if (event.type === 'response.audio_transcript.delta' || event.type === 'response.output_text.delta') {
    realtimeState.assistantBuffer += event.delta || '';
    return;
  }
  if (event.type === 'response.audio_transcript.done' || event.type === 'response.output_text.done') {
    const text = (event.transcript || event.text || realtimeState.assistantBuffer || '').trim();
    if (text) appendBubble(text, 'agent');
    realtimeState.assistantBuffer = '';
    return;
  }
  if (event.type === 'conversation.item.input_audio_transcription.completed') {
    if (event.transcript) appendBubble(event.transcript, 'user');
    return;
  }
  if (event.type === 'error') {
    appendBubble(`Realtime error: ${event.error?.message || 'Unknown error'}`, 'system');
    setStatus('Realtime error');
    setMicState('error', 'Realtime error', 'Use guided mode if the live session is unstable.');
  }
}

async function submitManualAnswer() {
  const value = manualAnswerInput.value.trim();
  if (!value) return;
  appendBubble(value, 'user');
  manualAnswerInput.value = '';
  await handleUserAnswer(value);
}

async function startGuidedSession() {
  setStatus('Starting');
  setMicState('connected', 'Preparing guided session', 'The browser voice loop will ask one question at a time.');
  await speak(`Starting the ${currentPlaybook.name} playbook. Please answer yes or no when possible. You can also use the quick buttons or typed fallback.`);
  if (!sessionActive) return;
  await askCurrentQuestion();
}

async function startSession() {
  stopSession({ silent: true });
  currentPlaybook = playbooks.find((p) => p.id === playbookSelect.value) || playbooks[0] || null;
  $('playbookValue').textContent = currentPlaybook?.name || '—';
  transcriptEl.innerHTML = '';
  transcriptLog = [];
  answers = {};
  factorIndex = 0;
  sessionActive = true;
  awaitingAnswer = false;
  markQuickAnswer('');
  renderDecision({ score: 0, level: 'minimal', recommendation: 'In progress', matchedFactors: [], nextSteps: [], narrative: 'Interview in progress.', reasoningSummary: [], coercionSignals: [], stressSignals: [], recommendedFollowUps: [], riskState: '—', customerState: '—' });
  if (!currentPlaybook) {
    appendBubble('No playbook loaded.', 'system');
    setStatus('No playbook loaded');
    return;
  }
  renderModeUI();
  if (selectedMode() === 'guided') {
    await startGuidedSession();
  } else {
    await startRealtimeSession();
  }
}

function disconnectRealtime() {
  try { realtimeState.dc?.close(); } catch {}
  try { realtimeState.pc?.close(); } catch {}
  try { realtimeState.stream?.getTracks()?.forEach((track) => track.stop()); } catch {}
  realtimeState = { pc: null, dc: null, stream: null, remoteAudio: null, sessionOpen: false, assistantBuffer: '' };
}

function stopSession(options = {}) {
  const { silent = false } = options;
  sessionActive = false;
  awaitingAnswer = false;
  stopListening();
  stopSpeaking();
  disconnectRealtime();
  if (!silent) {
    setStatus('Stopped');
    setMicState('connected', 'Stopped', 'You can evaluate the transcript or start a new session.');
  }
}

window.speechSynthesis.onvoiceschanged = populateVoices;
$('startBtn').addEventListener('click', () => startSession().catch((err) => {
  console.error(err);
  appendBubble(`Start failed: ${err.message}`, 'system');
  setStatus('Start failed');
  setMicState('error', 'Start failed', 'Check browser permissions and configuration.');
}));
$('stopBtn').addEventListener('click', () => stopSession());
$('evaluateBtn').addEventListener('click', async () => {
  if (!currentPlaybook) return;
  setStatus('Evaluating');
  setMicState('connected', 'Evaluating transcript', 'Building a scorecard from the latest session transcript.');
  await evaluateCurrentSession();
  setStatus('Evaluated');
});
$('submitManualAnswerBtn').addEventListener('click', () => submitManualAnswer());
manualAnswerInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    submitManualAnswer();
  }
});
document.querySelectorAll('.quick-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (!sessionActive || selectedMode() !== 'guided') return;
    const humanText = btn.dataset.answer === 'unsure' ? 'I am not sure.' : btn.dataset.answer;
    appendBubble(humanText, 'user');
    await handleUserAnswer(humanText, btn.dataset.answer);
  });
});
voiceModeSelect.addEventListener('change', renderModeUI);
playbookSelect.addEventListener('change', () => {
  currentPlaybook = playbooks.find((p) => p.id === playbookSelect.value) || null;
  $('playbookValue').textContent = currentPlaybook?.name || '—';
});

(async function init() {
  await loadPlaybooks();
  populateVoices();
  renderModeUI();
  setStatus('Idle');
  setMicState('connected', 'Idle', 'Press start to begin a guided or Realtime session.');
  renderDecision({ score: 0, level: 'minimal', recommendation: 'Not evaluated', matchedFactors: [], nextSteps: [], narrative: 'No case narrative generated yet.', reasoningSummary: [], coercionSignals: [], stressSignals: [], recommendedFollowUps: [], riskState: '—', customerState: '—' });
})();
