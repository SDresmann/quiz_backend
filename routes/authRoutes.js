const express = require('express');
const router = express.Router();

const Token = require('../schema/tokenSchema')

const {
  HUBSPOT_CLIENT_ID,
  HUBSPOT_CLIENT_SECRET,
  HUBSPOT_REDIRECT_URI,
  FRONTEND_URL,
} = require('../config');



async function saveHubSpotTokens(tokens) {
  await Token.findOneAndUpdate(
    { provider: 'hubspot' },
    {
      provider: 'hubspot',
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
      token_type: tokens.token_type,
      scope: tokens.scope,
      updatedAt: new Date(),
    },
    { upsert: true, new: true }
  );

  console.log('[TOKENS] HubSpot tokens saved to MongoDB');
}

router.get('/install', (req, res) => {
    console.log('[OAUTH] /auth/install hit');
  
    const scopes = [
      'oauth',
      'crm.objects.contacts.read',
      'crm.objects.contacts.write',
      'crm.objects.deals.read',
      'crm.objects.deals.write',
    ].join(' ');
  
    const url =
      `https://app.hubspot.com/oauth/authorize` +
      `?client_id=${encodeURIComponent(HUBSPOT_CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(HUBSPOT_REDIRECT_URI)}` +
      `&scope=${encodeURIComponent(scopes)}`;
  
    console.log('[OAUTH] Redirecting to:', url);
    res.redirect(url);
  });
  
  router.get('/callback', async (req, res) => {
    console.log('[OAUTH] /auth/callback hit');
    console.log('[OAUTH] Raw URL:', req.originalUrl);
    console.log('[OAUTH] Query params:', req.query);

    // Fallback: parse code from raw URL if query was stripped (e.g. proxy)
    const rawQuery = req.originalUrl.includes('?') ? req.originalUrl.split('?')[1] : '';
    const urlParams = new URLSearchParams(rawQuery);
    const codeFromUrl = urlParams.get('code');
    const errorFromUrl = urlParams.get('error');

    try {
      let code = req.query.code || codeFromUrl;
      const error = req.query.error || errorFromUrl;
      const error_description = req.query.error_description || urlParams.get('error_description');
  
      if (error) {
        console.error('[OAUTH] HubSpot returned error:', error, error_description);
        return res
          .status(400)
          .send(`HubSpot OAuth error: ${error} - ${error_description || ''}`);
      }

      if (!code) {
        console.error('[OAUTH] Missing code in callback. Received query:', req.query);
        return res.status(400).send(
          'Missing code. Check: 1) In HubSpot app Auth tab, add Redirect URL exactly: ' +
          HUBSPOT_REDIRECT_URI + ' 2) Run the flow from /api/auth/install in one go. Received: ' +
          JSON.stringify(req.query)
        );
      }
  
      console.log('[OAUTH] Exchanging code for tokens…');
      console.log('[OAUTH] Using redirect URI:', HUBSPOT_REDIRECT_URI);
  
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: HUBSPOT_CLIENT_ID,
        client_secret: HUBSPOT_CLIENT_SECRET,
        redirect_uri: HUBSPOT_REDIRECT_URI,
        code: String(code),
      });
  
      const response = await fetch('https://api.hubapi.com/oauth/v1/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
  
      const json = await response.json();
  
      if (!response.ok) {
        console.error('[OAUTH] Token exchange failed:', json);
        return res.status(500).json(json);
      }
  
      console.log('[OAUTH] Token exchange success:', {
        hasAccessToken: !!json.access_token,
        hasRefreshToken: !!json.refresh_token,
        expires_in: json.expires_in,
        scope: json.scope,
        token_type: json.token_type,
      });
  
      await saveHubSpotTokens(json);
      console.log('[TOKENS] HubSpot tokens saved to MongoDB');
  
      console.log('[OAUTH] Redirecting to frontend:', FRONTEND_URL);
      return res.redirect(FRONTEND_URL);
    } catch (err) {
      console.error('[OAUTH] /auth/callback crashed:', err);
      return res
        .status(500)
        .send(`OAuth callback error: ${err?.message || String(err)}`);
    }
  });

  module.exports = router;