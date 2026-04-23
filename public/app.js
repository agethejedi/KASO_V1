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

// ─── CASE STATE ───────────────────────────────────────────────────────────────
let currentCaseId = null;
let caseUserData = null;

// ─── CASE API HELPERS ─────────────────────────────────────────────────────────

async function openCase(userData, playbook) {
  try {
    const resp = await fetch('/api/cases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: {
          first: userData.first || '',
          last:  userData.last  || '',
          email: userData.email || '',
          phone: userData.phone || '',
        },
        playbook: {
          id:   playbook.id   || '',
          name: playbook.name || '',
        },
      }),
    });
    const data = await resp.json();
    if (data.ok && data.caseId) {
      currentCaseId = data.caseId;
      updateCaseChip(currentCaseId);
      showCaseToast(currentCaseId, userData.email);

      // Send case confirmation email — non-blocking
      fetch('/api/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseId:    data.caseId,
          firstName: userData.first,
          lastName:  userData.last,
          email:     userData.email,
          playbook:  playbook?.name || '',
          createdAt: data.createdAt,
        }),
      }).catch(err => console.warn('Email send failed (non-blocking):', err));

      return data.caseId;
    }
  } catch (err) {
    console.warn('Case open failed (non-blocking):', err);
  }
  return null;
}

async function saveCase(updates) {
  if (!currentCaseId) return;
  try {
    await fetch('/api/cases', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: currentCaseId, ...updates }),
    });
  } catch (err) {
    console.warn('Case save failed (non-blocking):', err);
  }
}

function updateCaseChip(caseId) {
  const chip   = $('caseChip');
  const chipId = $('caseChipId');
  if (chip && chipId) {
    chipId.textContent = caseId;
    chip.style.display = 'flex';
  }
}

function showCaseToast(caseId, email) {
  const toast       = $('caseToast');
  const toastCaseId = $('caseToastId');
  if (!toast) return;
  if (toastCaseId) toastCaseId.textContent = `${caseId} · ${email}`;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 5000);
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

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
  if (subtext)  micSubtext.textContent  = subtext;
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
  currentQuestionEl.textContent = guided ? 'Not started.' : 'Realtime agent will guide the interview.';
}

function stopListening() {
  if (!recognition || !recognitionActive) return;
  try { recognition.stop(); } catch (err) { console.warn('Recognition stop failed:', err); }
}

function stopSpeaking() {
  try { window.speechSynthesis.cancel(); } catch (err) { console.warn('speechSynthesis.cancel failed:', err); }
  isSpeaking = false;
}

async function playListeningCue() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const osc  = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.value = 0.0001;
    const now = audioCtx.currentTime;
    gain.gain.exponentialRampToValueAtTime(0.04,    now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001,  now + 0.12);
    osc.start(now);
    osc.stop(now + 0.12);
  } catch (err) { console.warn('Listening cue unavailable:', err); }
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
    const idx   = Number(voiceSelect.value || 0);
    if (voices[idx]) utter.voice = voices[idx];
    utter.rate  = 1;
    utter.pitch = 1;
    isSpeaking  = true;
    setMicState('speaking', 'Agent speaking', 'Please wait for the tone or listening state before answering.');
    suppressRecognitionUntil = Date.now() + preDelay + postDelay + 400;
    utter.onend = async () => { isSpeaking = false; await sleep(postDelay); resolve(); };
    utter.onerror = async () => { isSpeaking = false; await sleep(postDelay); resolve(); };
    try { window.speechSynthesis.speak(utter); }
    catch { isSpeaking = false; await sleep(postDelay); resolve(); }
  });
}

function getCurrentFactor() {
  return currentPlaybook?.factors?.[factorIndex] || null;
}

async function loadPlaybooks() {
  const resp = await fetch('/api/playbooks');
  const data = await resp.json();
  playbooks  = data.playbooks || [];
  playbookSelect.innerHTML = '';
  playbooks.forEach((p) => {
    const opt = document.createElement('option');
    opt.value       = p.id;
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
  rec.lang            = 'en-US';
  rec.interimResults  = false;
  rec.maxAlternatives = 1;
  rec.continuous      = false;

  rec.onresult = async (event) => {
    const transcript = event.results?.[0]?.[0]?.transcript?.trim();
    recognitionActive = false;
    if (!transcript) return;
    if (isSpeaking || Date.now() < suppressRecognitionUntil) return;
    appendBubble(transcript, 'user');
    awaitingAnswer      = false;
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
  if (/(yes|yeah|yep|i did|currently|correct|true|affirmative|sure|that happened|it did)/.test(t)) return 'yes';
  if (/(no|nope|not at all|did not|false|negative|never|it did not|don't think so)/.test(t))       return 'no';
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
    awaitingAnswer    = true;
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
  if (!factor) { await finishSession(); return; }
  currentQuestionEl.textContent = factor.question;
  awaitingAnswer = false;
  await speak(factor.question);
  if (!sessionActive) return;
  await listenForAnswer();
}

// ─── CHANGE 1: scoreTranscriptWithClaude ─────────────────────────────────────
// Calls /api/score-transcript to extract structured yes/no/unsure answers
// from a Realtime session transcript, then merges them into answers{}.

async function scoreTranscriptWithClaude() {
  if (!transcriptLog.length || !currentPlaybook?.factors?.length) return;
  try {
    setMicState('connected', 'Analysing transcript', 'Claude is extracting structured answers from the conversation…');
    const resp = await fetch('/api/score-transcript', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: transcriptLog,
        playbook:   currentPlaybook,
      }),
    });
    const data = await resp.json();
    if (data.ok && data.answers) {
      Object.assign(answers, data.answers);
      if (data.summary) appendBubble(`Analysis: ${data.summary}`, 'system');
      console.log('[KASO] Transcript scored — confidence:', data.confidence, '| answers:', data.answers);
    }
  } catch (err) {
    console.warn('Transcript scoring failed (non-blocking):', err);
  }
}

// ─── CHANGE 2: evaluateCurrentSession — Realtime path ────────────────────────
// For Realtime mode, extract structured answers before running the evaluator.

async function evaluateCurrentSession() {
  if (selectedMode() === 'realtime' && transcriptLog.length > 0) {
    await scoreTranscriptWithClaude();
  }

  const payload = {
    playbook:       currentPlaybook,
    answers,
    transcriptText: transcriptLog.map((entry) => `${entry.role}: ${entry.text}`).join('\n'),
  };
  const resp   = await fetch('/api/evaluate', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  const result = await resp.json();
  renderDecision(result);
  return result;
}

async function finishSession() {
  sessionActive  = false;
  awaitingAnswer = false;
  stopListening();
  setStatus('Evaluating');
  setMicState('connected', 'Evaluating', 'Scoring the interview and generating next steps.');
  if (selectedMode() === 'guided') {
    await speak('Thank you. I am evaluating the responses now.');
  }
  const result = await evaluateCurrentSession();
  setStatus('Completed');
  setMicState('connected', 'Session completed', 'Review the scorecard and next steps.');

  await saveCase({
    status:         'complete',
    score:          result.score,
    level:          result.level,
    recommendation: result.recommendation,
    matchedFactors: result.matchedFactors,
    nextSteps:      result.nextSteps,
    transcript:     transcriptLog,
    evidence:       window.__evidenceLog || [],
  });
}

function renderDecision(result) {
  $('scoreValue').textContent = String(result.score ?? 0);
  $('levelValue').textContent = result.level ? result.level[0].toUpperCase() + result.level.slice(1) : 'Unknown';
  $('levelValue').className   = `score-${result.level || 'minimal'}`;
  $('recommendationValue').textContent = result.recommendation || '—';
  $('playbookValue').textContent       = currentPlaybook?.name || '—';
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
    div.className   = 'step-item';
    div.textContent = step;
    steps.appendChild(div);
  });
}

async function handleUserAnswer(transcript, forced = null) {
  const factor = getCurrentFactor();
  if (!factor || !sessionActive) return;
  const normalized    = forced || normalizeYesNo(transcript);
  answers[factor.id]  = normalized;
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
  if (next) { await sleep(220); await askCurrentQuestion(); }
  else       { await finishSession(); }
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
    return `${idx + 1}. ${factor.name}: ask about ${factor.question}${cues} Weight ${factor.weight}.`;
  }).join('\n');

  const hardStops = (playbook?.hardStops || []).length
    ? `Hard stop patterns: ${(playbook.hardStops || []).join('; ')}.`
    : '';

  return [
    `You are a fraud response voice agent for the playbook: ${playbook?.name || 'Fraud review'}.`,
    'Interview the client in a calm, concise, banking-safe manner.',
    'Ask one question at a time. Adapt based on what the client says. Clarify when the answer is partial, hesitant, contradictory, rushed, or indicates coaching.',
    'Prioritize urgent containment if you hear remote access, live coaching, changed wire instructions, urgency, secrecy, or instructions to move money for safety.',
    'Do not approve or deny a transaction yourself. Gather facts, explain risk plainly, and end with a short summary plus recommended next steps.',
    hardStops,
    'Use the playbook factors below to guide questioning:',
    factorGuidance,
  ].filter(Boolean).join('\n\n');
}

async function startRealtimeSession() {
  const playbook = currentPlaybook;
  if (!playbook) { appendBubble('No playbook loaded.', 'system'); return; }
  setStatus('Connecting…');
  setMicState('connected', 'Connecting to OpenAI Realtime', 'Requesting a session token and preparing live voice.');
  appendBubble('Connecting to OpenAI Realtime voice…', 'system');

  const tokenResp = await fetch('/api/realtime-session', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      playbookId:   playbook.id,
      instructions: buildRealtimeInstructions(playbook),
      caseId:       currentCaseId,
    }),
  });
  const tokenData = await tokenResp.json();
  if (!tokenResp.ok || !tokenData.value) {
    appendBubble(tokenData.error || 'Realtime session could not be created. Configure OPENAI_API_KEY to enable this mode.', 'system');
    setStatus('Realtime unavailable');
    setMicState('error', 'Realtime unavailable', 'Check the OpenAI secret in Cloudflare or use guided mode.');
    return;
  }

  const pc          = new RTCPeerConnection();
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

    // Enable user speech transcription using GA API nested audio format
    dc.send(JSON.stringify({
      type: 'session.update',
      session: {
        type: 'realtime',
        audio: {
          input: {
            transcription: { model: 'whisper-1' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 600,
            },
          },
        },
      },
    }));

    // Begin the interview
    dc.send(JSON.stringify({
      type: 'response.create',
      response: {
        instructions: `Begin the ${playbook.name} interview now. Greet the client briefly, explain that you will ask a few questions for fraud protection, and then ask the first question.`,
      },
    }));
  });

  dc.addEventListener('message', (event) => {
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    handleRealtimeEvent(payload);
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Call OpenAI SDP endpoint directly with ephemeral token
  const sdpResp = await fetch('https://api.openai.com/v1/realtime/calls', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${tokenData.value}`,
      'Content-Type':  'application/sdp',
    },
    body: offer.sdp,
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
  // Temporary logging — remove after transcript capture is confirmed working
  console.log('[RT EVENT]', event.type, JSON.stringify(event).slice(0, 200));
  if (event.type === 'output_audio_buffer.started' || event.type === 'response.audio.delta') {
    setMicState('speaking', 'Agent speaking', 'OpenAI voice is responding. Wait for a natural pause before interrupting.');
    return;
  }
  if (event.type === 'output_audio_buffer.stopped' || event.type === 'response.audio.done') {
    setMicState('connected', 'Realtime connected', 'The agent is ready for the next client response.');
    return;
  }
  // GA API event names for agent transcript
  if (event.type === 'response.output_audio_transcript.delta' ||
      event.type === 'response.audio_transcript.delta' ||
      event.type === 'response.output_text.delta') {
    realtimeState.assistantBuffer += event.delta || '';
    return;
  }
  if (event.type === 'response.output_audio_transcript.done' ||
      event.type === 'response.audio_transcript.done' ||
      event.type === 'response.output_text.done') {
    const text = (event.transcript || event.text || realtimeState.assistantBuffer || '').trim();
    if (text) appendBubble(text, 'agent');
    realtimeState.assistantBuffer = '';
    return;
  }
  // GA API event names for user transcript
  if (event.type === 'conversation.item.input_audio_transcription.completed' ||
      event.type === 'conversation.item.input_audio_transcription.done') {
    const text = event.transcript || event.text || '';
    if (text) appendBubble(text, 'user');
    return;
  }
  // conversation.item.done captures agent text when audio transcript not available
  if (event.type === 'conversation.item.done') {
    const content = event.item?.content || [];
    content.forEach(c => {
      if (c.transcript && !realtimeState.assistantBuffer) {
        appendBubble(c.transcript, 'agent');
      }
    });
    realtimeState.assistantBuffer = '';
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
  if (!caseUserData) { showIntakeModal(); return; }

  pauseSession({ silent: true });
  currentPlaybook = playbooks.find((p) => p.id === playbookSelect.value) || playbooks[0] || null;
  $('playbookValue').textContent = currentPlaybook?.name || '—';
  transcriptEl.innerHTML = '';
  transcriptLog          = [];
  window.__evidenceLog   = [];
  answers                = {};
  factorIndex            = 0;
  sessionActive          = true;
  awaitingAnswer         = false;
  markQuickAnswer('');
  renderDecision({ score: 0, level: 'minimal', recommendation: 'In progress', matchedFactors: [], nextSteps: [] });

  if (!currentPlaybook) {
    appendBubble('No playbook loaded.', 'system');
    setStatus('No playbook loaded');
    return;
  }

  await openCase(caseUserData, currentPlaybook);

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

// ─── CHANGE 3: pauseSession replaces stopSession ──────────────────────────────
// Saves case as 'paused' instead of 'abandoned' — preserves transcript and
// evidence so the session can be resumed or evaluated later.

function pauseSession(options = {}) {
  const { silent = false } = options;
  const wasActive = sessionActive;
  sessionActive   = false;
  awaitingAnswer  = false;
  stopListening();
  stopSpeaking();
  disconnectRealtime();

  if (wasActive && currentCaseId) {
    saveCase({
      status:     'paused',
      transcript: transcriptLog,
      evidence:   window.__evidenceLog || [],
    });
  }

  if (!silent) {
    setStatus('Paused');
    setMicState('connected', 'Session paused', 'Press start to resume or evaluate the transcript so far.');
  }
}

// Backward-compatible alias used by startSession({ silent: true })
function stopSession(options = {}) {
  pauseSession(options);
}

// ─── INTAKE MODAL ─────────────────────────────────────────────────────────────

function showIntakeModal() {
  const modal = $('intakeModal');
  if (modal) modal.classList.remove('hidden');
}

function hideIntakeModal() {
  const modal = $('intakeModal');
  if (modal) modal.classList.add('hidden');
}

function initIntakeModal() {
  const form = $('intakeForm');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const first = $('intakeFirst').value.trim();
    const last  = $('intakeLast').value.trim();
    const email = $('intakeEmail').value.trim();
    const phone = $('intakePhone').value.trim();

    if (!first || !email) return;

    caseUserData = { first, last, email, phone };

    const stripName    = $('userStripName');
    const stripContact = $('userStripContact');
    const strip        = $('userStrip');
    if (stripName)    stripName.textContent    = `${first} ${last}`.toUpperCase();
    if (stripContact) stripContact.textContent = email + (phone ? ` · ${phone}` : '');
    if (strip)        strip.style.display      = 'flex';

    hideIntakeModal();
    await startSession();
  });
}

// ─── EVENT LISTENERS ──────────────────────────────────────────────────────────

window.speechSynthesis.onvoiceschanged = populateVoices;

$('startBtn').addEventListener('click', () => startSession().catch((err) => {
  console.error(err);
  appendBubble(`Start failed: ${err.message}`, 'system');
  setStatus('Start failed');
  setMicState('error', 'Start failed', 'Check browser permissions and configuration.');
}));

// CHANGE 3: stop button now calls pauseSession
$('stopBtn').addEventListener('click', () => pauseSession());

$('evaluateBtn').addEventListener('click', async () => {
  if (!currentPlaybook) return;
  setStatus('Evaluating');
  setMicState('connected', 'Evaluating transcript', 'Building a scorecard from the latest session transcript.');
  const result = await evaluateCurrentSession();
  setStatus('Evaluated');
  // Save score, transcript and evidence to KV
  if (currentCaseId && result) {
    saveCase({
      status:         'complete',
      score:          result.score,
      level:          result.level,
      recommendation: result.recommendation,
      matchedFactors: result.matchedFactors,
      nextSteps:      result.nextSteps,
      transcript:     transcriptLog,
      evidence:       window.__evidenceLog || [],
    });
  }
});

$('submitManualAnswerBtn').addEventListener('click', () => submitManualAnswer());

manualAnswerInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); submitManualAnswer(); }
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

// ─── INIT ─────────────────────────────────────────────────────────────────────

(async function init() {
  await loadPlaybooks();
  populateVoices();
  renderModeUI();
  setStatus('Idle');
  setMicState('connected', 'Idle', 'Press start to begin a guided or Realtime session.');
  renderDecision({ score: 0, level: 'minimal', recommendation: 'Not evaluated', matchedFactors: [], nextSteps: [] });
  initIntakeModal();
})();
