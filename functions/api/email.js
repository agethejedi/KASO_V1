/**
 * functions/api/email.js
 * KASO V1 — Case confirmation email via Resend
 *
 * POST /api/email
 * Called by app.js immediately after a case is created.
 * No auth required — rate-limited by case creation flow.
 *
 * Body: {
 *   caseId:    "RXL-XXXXXX-XXXX",
 *   firstName: "Jane",
 *   lastName:  "Smith",
 *   email:     "jane@example.com",
 *   playbook:  "Remote Access / Tech Support Scam",
 *   createdAt: "2026-04-21T03:11:36.627Z"
 * }
 */

function json(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST,OPTIONS',
      'access-control-allow-headers': 'Content-Type',
    },
    ...init,
  });
}

export async function onRequestOptions() {
  return json({ ok: true });
}

export async function onRequestPost(context) {
  const { env, request } = context;

  if (!env.RESEND_API_KEY) {
    return json({ error: 'RESEND_API_KEY is not configured.' }, { status: 400 });
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { caseId, firstName, lastName, email, playbook, createdAt } = body;

  if (!caseId || !email) {
    return json({ error: 'caseId and email are required.' }, { status: 400 });
  }

  // Format the timestamp
  const openedAt = createdAt
    ? new Date(createdAt).toLocaleString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
      })
    : new Date().toLocaleString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
      });

  const name = [firstName, lastName].filter(Boolean).join(' ') || 'there';

  const htmlBody = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Your Case Has Been Opened</title>
</head>
<body style="margin:0;padding:0;background:#070d0f;font-family:'Courier New',monospace;color:#a8c4c8;">

  <table width="100%" cellpadding="0" cellspacing="0" style="background:#070d0f;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="padding-bottom:24px;border-bottom:1px solid #182e32;">
              <p style="margin:0;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#4a6a70;">
                RISKXLABS / FRAUD AGENT
              </p>
              <h1 style="margin:8px 0 0;font-size:24px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#d4e8ea;font-family:'Courier New',monospace;">
                CASE OPENED
              </h1>
            </td>
          </tr>

          <!-- Case ID block -->
          <tr>
            <td style="padding:24px 0 20px;">
              <p style="margin:0 0 6px;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#4a6a70;">
                CASE REFERENCE
              </p>
              <div style="background:#0d1a1c;border:1px solid #244448;border-left:3px solid #2dd4bf;border-radius:4px;padding:14px 16px;">
                <span style="font-size:20px;font-weight:700;letter-spacing:2px;color:#2dd4bf;font-family:'Courier New',monospace;">
                  ${caseId}
                </span>
              </div>
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td style="padding-bottom:20px;">
              <p style="margin:0;font-size:14px;line-height:1.7;color:#a8c4c8;font-family:'Courier New',monospace;">
                Hi ${name},
              </p>
              <p style="margin:12px 0 0;font-size:14px;line-height:1.7;color:#a8c4c8;font-family:'Courier New',monospace;">
                Your fraud assessment case has been opened. Keep this email — your case reference number above is your record of this interaction and will be used if a specialist follows up with you.
              </p>
            </td>
          </tr>

          <!-- Case details -->
          <tr>
            <td style="padding-bottom:24px;">
              <p style="margin:0 0 10px;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#4a6a70;">
                CASE DETAILS
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1a1c;border:1px solid #182e32;border-radius:4px;">
                <tr>
                  <td style="padding:10px 14px;border-bottom:1px solid #182e32;">
                    <span style="font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:#4a6a70;">TYPE</span>
                  </td>
                  <td style="padding:10px 14px;border-bottom:1px solid #182e32;text-align:right;">
                    <span style="font-size:11px;color:#d4e8ea;font-family:'Courier New',monospace;">${playbook || 'FRAUD ASSESSMENT'}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:10px 14px;border-bottom:1px solid #182e32;">
                    <span style="font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:#4a6a70;">OPENED</span>
                  </td>
                  <td style="padding:10px 14px;border-bottom:1px solid #182e32;text-align:right;">
                    <span style="font-size:11px;color:#d4e8ea;font-family:'Courier New',monospace;">${openedAt}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:10px 14px;">
                    <span style="font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:#4a6a70;">STATUS</span>
                  </td>
                  <td style="padding:10px 14px;text-align:right;">
                    <span style="font-size:11px;color:#2dd4bf;font-family:'Courier New',monospace;">OPEN — UNDER REVIEW</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- What happens next -->
          <tr>
            <td style="padding-bottom:24px;">
              <p style="margin:0 0 10px;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#4a6a70;">
                WHAT HAPPENS NEXT
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1a1c;border:1px solid #182e32;border-radius:4px;padding:4px 0;">
                <tr>
                  <td style="padding:10px 14px;border-bottom:1px solid #182e32;">
                    <span style="color:#2dd4bf;font-size:11px;margin-right:10px;">01.</span>
                    <span style="font-size:12px;color:#a8c4c8;">Your responses have been recorded and scored.</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:10px 14px;border-bottom:1px solid #182e32;">
                    <span style="color:#2dd4bf;font-size:11px;margin-right:10px;">02.</span>
                    <span style="font-size:12px;color:#a8c4c8;">A fraud specialist may contact you at this email if follow-up is needed.</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:10px 14px;">
                    <span style="color:#2dd4bf;font-size:11px;margin-right:10px;">03.</span>
                    <span style="font-size:12px;color:#a8c4c8;">If you are in immediate danger of losing funds, contact your bank's fraud line now.</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Warning box -->
          <tr>
            <td style="padding-bottom:28px;">
              <div style="background:rgba(255,77,77,0.06);border:1px solid rgba(255,77,77,0.25);border-radius:4px;padding:14px 16px;">
                <p style="margin:0;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#ff4d4d;margin-bottom:6px;">
                  ⚠ IMPORTANT
                </p>
                <p style="margin:0;font-size:12px;line-height:1.65;color:#a8c4c8;font-family:'Courier New',monospace;">
                  Do not send money, gift cards, or cryptocurrency to anyone you cannot independently verify. Do not allow remote access to your device. If you are being pressured right now, hang up and call your bank directly.
                </p>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="border-top:1px solid #182e32;padding-top:20px;">
              <p style="margin:0;font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:#4a6a70;line-height:1.8;">
                RISKXLABS / FRAUD AGENT<br>
                CASEMANAGER@RISKXLABS.COM<br>
                THIS IS AN AUTOMATED MESSAGE — DO NOT REPLY DIRECTLY
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>`;

  const textBody = `RISKXLABS / FRAUD AGENT — CASE OPENED

Hi ${name},

Your fraud assessment case has been opened.

CASE REFERENCE: ${caseId}
TYPE: ${playbook || 'Fraud Assessment'}
OPENED: ${openedAt}
STATUS: Open — Under Review

WHAT HAPPENS NEXT:
01. Your responses have been recorded and scored.
02. A fraud specialist may contact you at this email if follow-up is needed.
03. If you are in immediate danger of losing funds, contact your bank's fraud line now.

IMPORTANT: Do not send money, gift cards, or cryptocurrency to anyone you cannot independently verify. Do not allow remote access to your device.

RiskXLabs / Fraud Agent
CaseManager@RiskXLabs.com
This is an automated message — do not reply directly.`;

  // Send via Resend
  let resendResp;
  try {
    resendResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from:    'CaseManager <CaseManager@riskxlabs.com>',
        to:      [email],
        subject: `Your Case Is Open — ${caseId}`,
        html:    htmlBody,
        text:    textBody,
      }),
    });
  } catch (err) {
    return json({ error: 'Failed to reach Resend API.', detail: String(err) }, { status: 502 });
  }

  const resendData = await resendResp.json();

  if (!resendResp.ok) {
    return json({
      error:  'Resend API returned an error.',
      detail: resendData,
    }, { status: resendResp.status });
  }

  return json({ ok: true, emailId: resendData.id });
}
