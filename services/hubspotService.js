// services/hubspotService.js
const hubspot = require('@hubspot/api-client');
const Token = require('../schema/tokenSchema');

const {
  HUBSPOT_CLIENT_ID,
  HUBSPOT_CLIENT_SECRET,
  HUBSPOT_STAGE_ACCEPTANCE_LETTER,
} = require('../config');

// If you're not on Node 18+, uncomment these two lines:
// const fetch = require('node-fetch'); // npm i node-fetch@2
// global.fetch = fetch;

async function getHubSpotTokens() {
  return await Token.findOne({ provider: 'hubspot' }).lean();
}

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

async function refreshHubSpotToken() {
  const tokens = await getHubSpotTokens();
  if (!tokens?.refresh_token) throw new Error('Missing refresh token (connect HubSpot first)');

  console.log('[HUBSPOT] Refreshing access token...');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: HUBSPOT_CLIENT_ID,
    client_secret: HUBSPOT_CLIENT_SECRET,
    refresh_token: tokens.refresh_token,
  });

  const res = await fetch('https://api.hubapi.com/oauth/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const json = await res.json();
  if (!res.ok) {
    console.error('[HUBSPOT] Refresh failed:', json);
    throw new Error('HubSpot refresh failed');
  }

  await saveHubSpotTokens({
    ...json,
    refresh_token: json.refresh_token || tokens.refresh_token,
  });

  console.log('[HUBSPOT] Refresh success');
  return json.access_token;
}

async function findContactIdByEmail(hsClient, email) {
  console.log('[HUBSPOT] Searching contact by email:', email);

  const search = await hsClient.crm.contacts.searchApi.doSearch({
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
    properties: ['email'],
    limit: 1,
  });

  const contactId = search?.results?.[0]?.id || null;
  console.log('[HUBSPOT] Search result contactId:', contactId);
  return contactId;
}

async function findMostRecentDealIdForContact(hsClient, contactId) {
  console.log('[HUBSPOT] Looking up deals associated to contact:', contactId);

  const assoc = await hsClient.crm.associations.v4.basicApi.getPage('contacts', contactId, 'deals');
  const dealIds = (assoc?.results || []).map((r) => r.toObjectId);

  console.log('[HUBSPOT] Associated dealIds:', dealIds);
  if (!dealIds.length) return null;

  let bestDealId = dealIds[0];
  let bestLastModified = 0;

  for (const dealId of dealIds) {
    try {
      const deal = await hsClient.crm.deals.basicApi.getById(
        dealId,
        ['hs_lastmodifieddate', 'dealname'],
        undefined,
        undefined,
        false
      );

      const lastMod = new Date(deal?.properties?.hs_lastmodifieddate || 0).getTime();

      console.log('[HUBSPOT] Deal candidate:', {
        dealId,
        dealname: deal?.properties?.dealname,
        hs_lastmodifieddate: deal?.properties?.hs_lastmodifieddate,
      });

      if (lastMod > bestLastModified) {
        bestLastModified = lastMod;
        bestDealId = dealId;
      }
    } catch (e) {
      console.warn('[HUBSPOT] Failed to fetch deal for sorting:', dealId, e?.message || e);
    }
  }

  console.log('[HUBSPOT] Selected dealId:', bestDealId);
  return bestDealId;
}

async function updateHubSpotScores(email, scores, passed) {
  const tokens = await getHubSpotTokens();
  if (!tokens?.access_token) throw new Error('HubSpot not connected');

  let accessToken = tokens.access_token;
  let hs = new hubspot.Client({ accessToken });

  async function attemptUpdate() {
    const contactId = await findContactIdByEmail(hs, email);
    if (!contactId) return { updated: false, reason: 'Contact not found' };

    const dealId = await findMostRecentDealIdForContact(hs, contactId);
    if (!dealId) return { updated: false, reason: 'No deal found' };

    // ✅ Build properties (deal properties must exist in HubSpot)
    const properties = {
      logical_reasoning: String(scores.logical_reasoning),
      verbal_reasoning: String(scores.verbal_reasoning),
      numerical_reasoning: String(scores.numerical_reasoning),
    };

    // ✅ Move deal to Acceptance Letter from ANY stage if passed
    if (passed) {
      if (!HUBSPOT_STAGE_ACCEPTANCE_LETTER) {
        console.warn('[HUBSPOT] Passed=true but HUBSPOT_STAGE_ACCEPTANCE_LETTER is not configured');
        return { updated: false, reason: 'Acceptance stage ID not configured' };
      }
      properties.dealstage = HUBSPOT_STAGE_ACCEPTANCE_LETTER;
      console.log(
        '[HUBSPOT] Passed=true → moving deal to Acceptance Letter:',
        properties.dealstage
      );
    } else {
      console.log('[HUBSPOT] Passed=false → dealstage unchanged');
    }

    console.log('[HUBSPOT] Updating deal...', { dealId, properties });

    await hs.crm.deals.basicApi.update(dealId, { properties });

    console.log('[HUBSPOT] Deal update OK');
    return { updated: true, dealId };
  }

  try {
    return await attemptUpdate();
  } catch (err) {
    const msg = String(err?.message || err);
    console.error('[HUBSPOT] Deal update failed:', msg);

    // Token expired/unauthorized → refresh once and retry
    if (msg.includes('401') || msg.toLowerCase().includes('unauthorized') || msg.toLowerCase().includes('expired')) {
      console.warn('[HUBSPOT] Unauthorized/expired. Refreshing token and retrying once…');
      accessToken = await refreshHubSpotToken();
      hs = new hubspot.Client({ accessToken });

      const result = await attemptUpdate();
      return { ...result, refreshed: true };
    }

    throw err;
  }
}

module.exports = {
  updateHubSpotScores,
  saveHubSpotTokens,
  getHubSpotTokens,
  refreshHubSpotToken,
};
