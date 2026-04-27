// services/hubspotService.js
const hubspot = require('@hubspot/api-client');
const Token = require('../schema/tokenSchema');

const {
  HUBSPOT_CLIENT_ID,
  HUBSPOT_CLIENT_SECRET,
  HUBSPOT_STAGE_ACCEPTANCE_LETTER,
  HUBSPOT_STAGE_ASSESSMENTS,
  HUBSPOT_PIPELINE_ID,
  HUBSPOT_LOGICAL_REASONING_FIELD,
  HUBSPOT_VERBAL_REASONING_FIELD,
  HUBSPOT_NUMERICAL_REASONING_FIELD,
} = require('../config');

// If you're not on Node 18+, uncomment these two lines:
// const fetch = require('node-fetch'); // npm i node-fetch@2
// global.fetch = fetch;

function hubSpotErrorSummary(err) {
  if (!err) return String(err);
  const code = err.code ?? err.statusCode;
  const body = err.body;
  let detail = '';
  if (body && typeof body === 'object') {
    detail = body.message || JSON.stringify(body);
  } else if (body != null) {
    detail = String(body);
  } else {
    detail = err.message || String(err);
  }
  return code != null ? `HTTP ${code}: ${detail}` : detail;
}

let resolvedPipelineCache = { raw: null, resolved: null, expiresAt: 0 };
let resolvePipelineInFlight = null;

function isNumericId(value) {
  return /^\d+$/.test(String(value || '').trim());
}

/**
 * HubSpot deal `pipeline` is a pipeline id string. Env may contain a friendly value like "default".
 * Resolve to the actual pipeline id using HubSpot Pipelines API (cached briefly).
 */
async function resolvePreferredPipelineId(hsClient) {
  const raw = String(HUBSPOT_PIPELINE_ID || '').trim();
  if (!raw) return null;

  // Already a HubSpot pipeline id (numeric string)
  if (isNumericId(raw)) return raw;

  const now = Date.now();
  if (
    resolvedPipelineCache.resolved &&
    resolvedPipelineCache.raw === raw.toLowerCase() &&
    resolvedPipelineCache.expiresAt > now
  ) {
    return resolvedPipelineCache.resolved;
  }

  if (resolvePipelineInFlight) return resolvePipelineInFlight;

  resolvePipelineInFlight = (async () => {
    const key = raw.toLowerCase();
    const resp = await hsClient.crm.pipelines.pipelinesApi.getAll('deals');
    const pipelines = resp?.results || [];

    const pickDefaultPipeline = () => {
      const active = pipelines.filter((p) => !p.archived);
      const byLabel = active.find((p) => String(p.label || '').toLowerCase().includes('default'));
      if (byLabel) return String(byLabel.id);
      const sorted = [...active].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
      if (sorted[0]) return String(sorted[0].id);
      if (pipelines[0]) return String(pipelines[0].id);
      return null;
    };

    let resolved = null;
    if (key === 'default' || key === 'primary') {
      resolved = pickDefaultPipeline();
    } else {
      const match = pipelines.find((p) => String(p.label || '').trim().toLowerCase() === key);
      resolved = match ? String(match.id) : null;
    }

    if (!resolved) {
      console.warn('[HUBSPOT] Could not resolve HUBSPOT_PIPELINE_ID from value:', raw);
    } else {
      console.log('[HUBSPOT] Resolved HUBSPOT_PIPELINE_ID:', { raw, resolved });
    }

    resolvedPipelineCache = {
      raw: key,
      resolved,
      expiresAt: Date.now() + 10 * 60 * 1000,
    };
    return resolved;
  })()
    .finally(() => {
      resolvePipelineInFlight = null;
    });

  return resolvePipelineInFlight;
}

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

async function findMostRecentDealForContact(hsClient, contactId) {
  console.log('[HUBSPOT] Looking up deals associated to contact:', contactId);

  const assoc = await hsClient.crm.associations.v4.basicApi.getPage('contacts', contactId, 'deals');
  const dealIds = (assoc?.results || []).map((r) => r.toObjectId);

  console.log('[HUBSPOT] Associated dealIds:', dealIds);
  if (!dealIds.length) return null;

  const preferredPipelineRaw = String(HUBSPOT_PIPELINE_ID || '').trim();
  const preferredPipeline = preferredPipelineRaw ? await resolvePreferredPipelineId(hsClient) : null;
  const candidates = [];

  for (const dealId of dealIds) {
    try {
      const deal = await hsClient.crm.deals.basicApi.getById(
        dealId,
        ['hs_lastmodifieddate', 'dealname', 'pipeline', 'dealstage'],
        undefined,
        undefined,
        false
      );

      const lastMod = new Date(deal?.properties?.hs_lastmodifieddate || 0).getTime();
      const pipeline = String(deal?.properties?.pipeline || '').trim();
      const dealstage = String(deal?.properties?.dealstage || '').trim();

      console.log('[HUBSPOT] Deal candidate:', {
        dealId,
        dealname: deal?.properties?.dealname,
        hs_lastmodifieddate: deal?.properties?.hs_lastmodifieddate,
        pipeline,
        dealstage,
      });
      candidates.push({ dealId, lastMod, pipeline, dealstage });
    } catch (e) {
      console.warn('[HUBSPOT] Failed to fetch deal for sorting:', dealId, e?.message || e);
    }
  }

  if (!candidates.length) return null;

  const inPreferredPipeline = preferredPipeline
    ? candidates.filter((c) => c.pipeline === preferredPipeline)
    : candidates;

  if (preferredPipeline && !inPreferredPipeline.length) {
    console.warn(
      '[HUBSPOT] No associated deals found in preferred pipeline',
      { preferredPipelineRaw, preferredPipelineResolved: preferredPipeline },
      'falling back to most recently modified associated deal'
    );
  }

  const pool = inPreferredPipeline.length ? inPreferredPipeline : candidates;
  pool.sort((a, b) => b.lastMod - a.lastMod);
  const selected = pool[0];

  console.log('[HUBSPOT] Selected deal:', selected);
  return selected;
}

/**
 * Patch the contact's most recent deal. Retries once on token expiry.
 * @param {string} email
 * @param {Record<string, string>} properties HubSpot deal property names → string values
 */
async function patchHubSpotDealForEmail(email, properties) {
  const tokens = await getHubSpotTokens();
  if (!tokens?.access_token) throw new Error('HubSpot not connected');

  let accessToken = tokens.access_token;
  let hs = new hubspot.Client({ accessToken });

  class HubSpotDealPatchError extends Error {
    constructor(details) {
      super(details?.hubspotError?.message || 'HubSpot deal update failed');
      this.name = 'HubSpotDealPatchError';
      this.details = details;
    }
  }

  async function attemptUpdate() {
    const contactId = await findContactIdByEmail(hs, email);
    if (!contactId) return { updated: false, reason: 'Contact not found', contactId: null };

    const deal = await findMostRecentDealForContact(hs, contactId);
    if (!deal) return { updated: false, reason: 'No deal found', contactId };

    const dealId = deal.dealId;
    console.log('[HUBSPOT] Updating deal...', {
      contactId,
      dealId,
      pipeline: deal.pipeline,
      dealstage: deal.dealstage,
      properties,
    });

    try {
      await hs.crm.deals.basicApi.update(dealId, { properties });
    } catch (e) {
      throw new HubSpotDealPatchError({
        updated: false,
        reason: 'HubSpot deal update failed',
        contactId,
        dealId,
        pipeline: deal.pipeline,
        previousDealStage: deal.dealstage,
        hubspotError: hubSpotErrorSummary(e),
      });
    }

    console.log('[HUBSPOT] Deal update OK');
    return {
      updated: true,
      contactId,
      dealId,
      pipeline: deal.pipeline,
      previousDealStage: deal.dealstage,
    };
  }

  try {
    return await attemptUpdate();
  } catch (err) {
    if (err?.name === 'HubSpotDealPatchError' && err?.details) {
      return err.details;
    }

    const msg = String(err?.message || err);
    console.error('[HUBSPOT] Deal update failed:', hubSpotErrorSummary(err));

    if (msg.includes('401') || msg.toLowerCase().includes('unauthorized') || msg.toLowerCase().includes('expired')) {
      console.warn('[HUBSPOT] Unauthorized/expired. Refreshing token and retrying once…');
      accessToken = await refreshHubSpotToken();
      hs = new hubspot.Client({ accessToken });

      try {
        const result = await attemptUpdate();
        return { ...result, refreshed: true };
      } catch (err2) {
        if (err2?.name === 'HubSpotDealPatchError' && err2?.details) {
          return { ...err2.details, refreshed: true };
        }
        throw err2;
      }
    }

    throw err;
  }
}

async function updateHubSpotScores(email, scores, passed) {
  // Explicit property mapping keeps section scores aligned to the correct HubSpot fields.
  console.log('[HUBSPOT] Score input:', {
    email,
    logical_reasoning: scores.logical_reasoning,
    verbal_reasoning: scores.verbal_reasoning,
    numerical_reasoning: scores.numerical_reasoning,
    passed,
  });
  console.log('[HUBSPOT] Field mapping:', {
    logical_reasoning_field: HUBSPOT_LOGICAL_REASONING_FIELD,
    verbal_reasoning_field: HUBSPOT_VERBAL_REASONING_FIELD,
    numerical_reasoning_field: HUBSPOT_NUMERICAL_REASONING_FIELD,
  });

  const scoreProperties = {
    [HUBSPOT_LOGICAL_REASONING_FIELD]: String(scores.logical_reasoning ?? 0),
    [HUBSPOT_VERBAL_REASONING_FIELD]: String(scores.verbal_reasoning ?? 0),
    [HUBSPOT_NUMERICAL_REASONING_FIELD]: String(scores.numerical_reasoning ?? 0),
  };
  console.log('[HUBSPOT] Score properties payload:', scoreProperties);

  if (!passed) {
    console.log('[HUBSPOT] Passed=false → dealstage unchanged');
    return patchHubSpotDealForEmail(email, scoreProperties);
  }

  if (!HUBSPOT_STAGE_ACCEPTANCE_LETTER) {
    console.warn('[HUBSPOT] Passed=true but HUBSPOT_STAGE_ACCEPTANCE_LETTER is not configured');
    return { updated: false, reason: 'Acceptance stage ID not configured' };
  }

  const stage = String(HUBSPOT_STAGE_ACCEPTANCE_LETTER).trim();
  const withStage = { ...scoreProperties, dealstage: stage };
  console.log('[HUBSPOT] Passed=true → PATCH deal (scores + dealstage):', stage);

  try {
    return await patchHubSpotDealForEmail(email, withStage);
  } catch (err) {
    console.error('[HUBSPOT] Scores + stage PATCH failed:', hubSpotErrorSummary(err));
    console.warn('[HUBSPOT] Retrying dealstage only (custom score properties may be missing on Deal)...');
    try {
      const stageOnly = await patchHubSpotDealForEmail(email, { dealstage: stage });
      return {
        ...stageOnly,
        scorePropertiesSkipped: true,
        scorePatchError: hubSpotErrorSummary(err),
      };
    } catch (err2) {
      console.error('[HUBSPOT] dealstage-only retry also failed:', hubSpotErrorSummary(err2));
      throw err2;
    }
  }
}

/** First quiz activity this attempt: move deal to configured Assessments stage. */
async function moveDealToAssessmentsStage(email) {
  if (!HUBSPOT_STAGE_ASSESSMENTS) {
    console.warn('[HUBSPOT] Assessments stage move skipped: HUBSPOT_STAGE_ASSESSMENTS / HUBSPOT_ASSESSMENTS_STAGE_ID not set');
    return { updated: false, reason: 'Assessments stage ID not configured' };
  }

  const stage = String(HUBSPOT_STAGE_ASSESSMENTS).trim();
  console.log('[HUBSPOT] Quiz started / in progress → dealstage:', stage);
  return patchHubSpotDealForEmail(email, { dealstage: stage });
}

module.exports = {
  updateHubSpotScores,
  moveDealToAssessmentsStage,
  saveHubSpotTokens,
  getHubSpotTokens,
  refreshHubSpotToken,
};
