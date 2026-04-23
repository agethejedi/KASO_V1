/**
 * functions/api/realtime-sdp.js
 * KASO V1 — SDP proxy for OpenAI Realtime WebRTC
 *
 * POST /api/realtime-sdp
 *
 * The browser cannot POST directly to api.openai.com due to CORS.
 * This Worker proxies the SDP offer to OpenAI and returns the answer SDP.
 *
 * Body: {
 *   sdp:   "v=0\r\no=...",   // browser's offer SDP string
 *   token: "ek_..."          // ephemeral token from /api/realtime-session
 * }
 *
 * Returns the raw SDP answer string from OpenAI.
 */

function corsHeaders() {
  return {
    'access-control-allow-origin':  '*',
    'access-control-allow-methods': 'POST,OPTIONS',
    'access-control-allow-headers': 'Content-Type',
  };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestPost(context) {
  const { request } = context;

  let body = {};
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON body.' }),
      { status: 400, headers: { 'content-type': 'application/json', ...corsHeaders() } }
    );
  }

  const { sdp, token } = body;

  if (!sdp) {
    return new Response(
      JSON.stringify({ error: 'sdp is required.' }),
      { status: 400, headers: { 'content-type': 'application/json', ...corsHeaders() } }
    );
  }

  if (!token) {
    return new Response(
      JSON.stringify({ error: 'token is required.' }),
      { status: 400, headers: { 'content-type': 'application/json', ...corsHeaders() } }
    );
  }

  // Forward SDP to OpenAI
  let openaiResp;
  try {
    openaiResp = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/sdp',
      },
      body: sdp,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'Failed to reach OpenAI Realtime API.', detail: String(err) }),
      { status: 502, headers: { 'content-type': 'application/json', ...corsHeaders() } }
    );
  }

  if (!openaiResp.ok) {
    const errText = await openaiResp.text();
    return new Response(
      JSON.stringify({ error: 'OpenAI rejected the SDP offer.', detail: errText }),
      { status: openaiResp.status, headers: { 'content-type': 'application/json', ...corsHeaders() } }
    );
  }

  // Return the answer SDP as plain text
  const answerSdp = await openaiResp.text();
  return new Response(answerSdp, {
    status: 200,
    headers: {
      'content-type': 'application/sdp',
      ...corsHeaders(),
    },
  });
}
