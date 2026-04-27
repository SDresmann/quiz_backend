// services/emailService.js
const nodemailer = require('nodemailer');
const {
    GRAPH_CLIENT_ID,
    GRAPH_CLIENT_SECRET,
    GRAPH_TENANT_ID,
    GRAPH_SENDER_EMAIL,
    PASS_URL, // fallback if passUrl isn't provided
    QUIZ_PASS_PERCENT,
    EMAIL_HOST,
    EMAIL_USER,
    EMAIL_PASS,
    EMAIL_FROM,
    INTERNAL_QUIZ_SUMMARY_TO,
  } = require('../config');
  
  async function getGraphAccessToken() {
    console.log('[GRAPH] Requesting access token (client credentials)…');
    console.log('[GRAPH] Using tenant:', GRAPH_TENANT_ID);
    console.log('[GRAPH] Using clientId:', GRAPH_CLIENT_ID);
    console.log('[GRAPH] Using sender:', GRAPH_SENDER_EMAIL);
  
    const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(
      GRAPH_TENANT_ID
    )}/oauth2/v2.0/token`;
  
    const body = new URLSearchParams({
      client_id: GRAPH_CLIENT_ID,
      client_secret: GRAPH_CLIENT_SECRET,
      grant_type: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default',
    });
  
    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  
    const raw = await tokenRes.text();
    let tokenJson = null;
  
    try {
      tokenJson = JSON.parse(raw);
    } catch {
      tokenJson = { raw };
    }
  
    if (!tokenRes.ok) {
      console.error('[GRAPH] Token request FAILED:', {
        status: tokenRes.status,
        statusText: tokenRes.statusText,
        body: tokenJson,
      });
      throw new Error('Graph token request failed');
    }
  
    console.log('[GRAPH] Token OK. Expires in:', tokenJson.expires_in);
    return tokenJson.access_token;
  }
  
  function buildPassFailEmail({ firstName, percent, retakeUrl, passUrl }) {
    const passed = percent >= QUIZ_PASS_PERCENT;
    const finalPassUrl = passUrl || PASS_URL;
  
    if (passed) {
      return {
        subject: 'Assessment Result: Passed',
        bodyText: `Hi ${firstName || ''},
  
  Congratulations — you PASSED the assessment!
  We are pleased to inform you that you have been admitted into the upcoming program starting soon!
  In order to secure your spot in class, you will need to schedule an acceptance call with your
  Admissions Coach, Hanya. Please use the link below to do so.
  
  ${finalPassUrl}
  
  Congratulations on your acceptance to the Kable Academy! Your outstanding test scores along with your clear commitment to personal and professional growth impressed us, and we are excited to welcome you aboard.
  We believe you will be a valuable addition to our community, and we are eager to support you in your journey to a successful career in technology. Our program is designed to equip you with the knowledge and skills you need to excel in the tech industry.
  
  Welcome to the Kable Academy, ${firstName}, where your future in technology begins.
  
  Thanks,
  Kable Academy`,
      };
    }
  
    return {
      subject: 'Assessment Result: Try Again',
      bodyText: `Hi ${firstName || ''},
  
  Thank you for completing the assessment.
  
  Unfortunately, this score does not meet the minimum passing requirement.
  
  To retake the assessment, please use the link below:
  ${retakeUrl}
  
  Note: This link can only be used once and will expire.
  
  Thanks,
  Kable Academy`,
    };
  }
  
  async function sendPassFailEmailGraph({ toEmail, firstName, percent, retakeUrl, passUrl }) {
    console.log('[FLOW] Sending pass/fail email now...');
    const passed = percent >= QUIZ_PASS_PERCENT;
  
    console.log(
      `[EMAIL] Preparing ${passed ? 'PASS' : 'FAIL'} email for ${toEmail} (percent=${percent})`
    );
  
    const { subject, bodyText } = buildPassFailEmail({ firstName, percent, retakeUrl, passUrl });
  
    const accessToken = await getGraphAccessToken();
  
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(
      GRAPH_SENDER_EMAIL
    )}/sendMail`;
  
    console.log('[EMAIL] Sending email...', `from="${GRAPH_SENDER_EMAIL}"`, `to="${toEmail}"`);
  
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: 'Text', content: bodyText },
          toRecipients: [{ emailAddress: { address: toEmail } }],
        },
        saveToSentItems: true,
      }),
    });
  
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('[EMAIL] Graph sendMail FAILED:', resp.status, errText);
      throw new Error(`Graph sendMail failed (${resp.status})`);
    }
  
    console.log('[EMAIL] Graph sendMail OK');
  }

  async function sendInternalQuizSectionSummaryEmail({
    toEmail,
    candidate,
    scores,
    totals,
    percent,
    passed,
  }) {
    const dest = String(toEmail || '').trim();
    if (!dest) {
      console.warn('[EMAIL] Internal summary skipped: no recipient');
      return { sent: false, reason: 'No recipient' };
    }

    const host = String(EMAIL_HOST || '').trim();
    const user = String(EMAIL_USER || '').trim();
    const pass = String(EMAIL_PASS || '').trim();
    if (!host || !user || !pass) {
      console.warn('[EMAIL] Internal summary skipped: EMAIL_HOST / EMAIL_USER / EMAIL_PASS not fully configured');
      return { sent: false, reason: 'SMTP not configured' };
    }

    const from = String(EMAIL_FROM || user).trim();
    const name = [candidate?.firstName, candidate?.lastName].filter(Boolean).join(' ').trim();
    const subject = `Quiz submitted — ${name || candidate?.email || 'unknown'}`;

    const bodyText = `A learner submitted the Kable Academy assessment.

Name: ${name || '(not provided)'}
Email: ${candidate?.email || ''}
Phone: ${candidate?.phone || ''}

Section scores (correct / total):
• Logical reasoning: ${scores.logical}/${totals.logical}
• Verbal reasoning: ${scores.verbal}/${totals.verbal}
• Numerical reasoning: ${scores.numerical}/${totals.numerical}

Overall: ${percent}% — ${passed ? 'PASSED' : 'DID NOT PASS'} (pass threshold ${QUIZ_PASS_PERCENT}%)
`;

    const transporter = nodemailer.createTransport({
      host,
      port: 587,
      secure: false,
      auth: { user, pass },
    });

    console.log('[EMAIL] Sending internal section summary…', { to: dest, from });
    await transporter.sendMail({
      from,
      to: dest,
      subject,
      text: bodyText,
    });
    console.log('[EMAIL] Internal section summary sent.');
    return { sent: true };
  }
  
  module.exports = {
    sendPassFailEmailGraph,
    buildPassFailEmail,
    sendInternalQuizSectionSummaryEmail,
  };
  