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
let resolvedStageCache = new Map(); // key: `${pipelineId}|${raw}` → stageId

function isNumericId(value) {
  return /^\d+$/.test(String(value || '').trim());
}

/**
 * Resolve a deal stage env value to { stageId, pipelineId }.
 * Accepts a numeric stage id, or a stage label (e.g. "Acceptance Letter").
 */
async function resolveDealStage(hsClient, preferredPipelineId, rawStage) {
  const raw = String(rawStage || '').trim();
  if (!raw) return null;

  const pipelineKey = String(preferredPipelineId || '').trim() || 'any';
  const cacheKey = `${pipelineKey}|${raw.toLowerCase()}`;
  const cached = resolvedStageCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { stageId: cached.stageId, pipelineId: cached.pipelineId, label: cached.label };
  }

  const resp = await hsClient.crm.pipelines.pipelinesApi.getAll('deals');
  const pipelines = (resp?.results || []).filter((p) => !p.archived);
  const preferred = preferredPipelineId
    ? pipelines.find((p) => String(p.id) === String(preferredPipelineId))
    : null;
  const searchOrder = preferred
    ? [preferred, ...pipelines.filter((p) => p !== preferred)]
    : pipelines;

  const needle = raw.toLowerCase();
  const isId = isNumericId(raw);

  for (const pipeline of searchOrder) {
    const stages = pipeline?.stages || [];
    let match = null;
    if (isId) {
      match = stages.find((s) => String(s.id) === raw);
    } else {
      match =
        stages.find((s) => String(s.label || '').trim().toLowerCase() === needle) ||
        stages.find((s) => String(s.label || '').trim().toLowerCase().includes(needle));
    }
    if (match?.id) {
      const result = {
        stageId: String(match.id),
        pipelineId: String(pipeline.id),
        label: match.label || null,
      };
      console.log('[HUBSPOT] Resolved deal stage:', {
        raw,
        ...result,
        pipelineLabel: pipeline.label,
      });
      resolvedStageCache.set(cacheKey, {
        ...result,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });
      return result;
    }
  }

  // Numeric id not found in any pipeline — still return it, but without pipeline
  if (isId) {
    console.warn('[HUBSPOT] Stage id not found in any deal pipeline; using raw id:', raw);
    return { stageId: raw, pipelineId: preferredPipelineId || null, label: null };
  }

  console.warn('[HUBSPOT] Could not resolve deal stage from value:', raw);
  return null;
}

/** @deprecated use resolveDealStage; kept for callers that only need the stage id */
async function resolveDealStageId(hsClient, pipelineId, rawStage) {
  const resolved = await resolveDealStage(hsClient, pipelineId, rawStage);
  return resolved?.stageId || null;
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

async function createContact(hsClient, user) {
  const email = String(user?.email || '').trim().toLowerCase();
  const properties = {
    email,
    firstname: String(user?.firstName || '').trim(),
    lastname: String(user?.lastName || '').trim(),
  };
  const phone = String(user?.phone || '').trim();
  if (phone) properties.phone = phone;

  console.log('[HUBSPOT] Creating contact (not found in HubSpot):', { email });
  const created = await hsClient.crm.contacts.basicApi.create({ properties });
  const contactId = created?.id ? String(created.id) : null;
  console.log('[HUBSPOT] Contact created:', contactId);
  return contactId;
}

async function createDealInAssessmentsStage(hsClient, { contactId, user, stageId, pipelineId }) {
  const nameParts = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim();
  const dealname = nameParts
    ? `${nameParts} - Assessment`
    : `${user?.email || 'Learner'} - Assessment`;

  const properties = {
    dealname,
    dealstage: String(stageId),
  };
  if (pipelineId) properties.pipeline = String(pipelineId);

  console.log('[HUBSPOT] Creating deal in Assessments stage:', {
    contactId,
    properties,
  });

  // Association type 3 = deal → contact
  const created = await hsClient.crm.deals.basicApi.create({
    properties,
    associations: contactId
      ? [
          {
            to: { id: contactId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }],
          },
        ]
      : undefined,
  });

  const dealId = created?.id ? String(created.id) : null;
  console.log('[HUBSPOT] Deal created:', dealId);
  return dealId;
}

async function findMostRecentDealForContact(hsClient, contactId, preferredPipelineOverride = null) {
  console.log('[HUBSPOT] Looking up deals associated to contact:', contactId);

  const assoc = await hsClient.crm.associations.v4.basicApi.getPage('contacts', contactId, 'deals');
  const dealIds = (assoc?.results || []).map((r) => r.toObjectId);

  console.log('[HUBSPOT] Associated dealIds:', dealIds);
  if (!dealIds.length) return null;

  const preferredPipelineRaw = String(HUBSPOT_PIPELINE_ID || '').trim();
  const preferredPipeline =
    preferredPipelineOverride ||
    (preferredPipelineRaw ? await resolvePreferredPipelineId(hsClient) : null);
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
      candidates.push({ dealId: String(dealId), lastMod, pipeline, dealstage });
    } catch (e) {
      console.warn('[HUBSPOT] Failed to fetch deal for sorting:', dealId, e?.message || e);
    }
  }

  if (!candidates.length) return null;

  const inPreferredPipeline = preferredPipeline
    ? candidates.filter((c) => c.pipeline === String(preferredPipeline))
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
 * When setting dealstage, HubSpot requires the matching pipeline — always include both.
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

    // HubSpot requires pipeline + dealstage together when moving stages.
    const props = { ...properties };
    if (props.dealstage && !props.pipeline) {
      const stageInfo = await resolveDealStage(hs, null, props.dealstage);
      if (stageInfo?.pipelineId) {
        props.pipeline = stageInfo.pipelineId;
        console.log('[HUBSPOT] Including pipeline with dealstage:', {
          dealstage: props.dealstage,
          pipeline: props.pipeline,
          stageLabel: stageInfo.label,
        });
      }
    }

    const deal = await findMostRecentDealForContact(hs, contactId, props.pipeline || null);
    if (!deal) return { updated: false, reason: 'No deal found', contactId };

    const dealId = deal.dealId;
    console.log('[HUBSPOT] Updating deal...', {
      contactId,
      dealId,
      pipeline: deal.pipeline,
      dealstage: deal.dealstage,
      properties: props,
    });

    try {
      await hs.crm.deals.basicApi.update(dealId, { properties: props });
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
      pipeline: props.pipeline || deal.pipeline,
      previousDealStage: deal.dealstage,
      dealstage: props.dealstage || deal.dealstage,
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

async function patchHubSpotContactScores(email, scoreProperties) {
  const tokens = await getHubSpotTokens();
  if (!tokens?.access_token) throw new Error('HubSpot not connected');

  let accessToken = tokens.access_token;
  let hs = new hubspot.Client({ accessToken });

  async function attempt() {
    const contactId = await findContactIdByEmail(hs, email);
    if (!contactId) return { updated: false, reason: 'Contact not found', contactId: null };

    console.log('[HUBSPOT] Updating CONTACT score properties...', { contactId, scoreProperties });
    await hs.crm.contacts.basicApi.update(contactId, { properties: scoreProperties });
    console.log('[HUBSPOT] Contact score properties PATCH OK');
    return { updated: true, contactId, via: 'contact' };
  }

  try {
    return await attempt();
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes('401') || msg.toLowerCase().includes('unauthorized') || msg.toLowerCase().includes('expired')) {
      accessToken = await refreshHubSpotToken();
      hs = new hubspot.Client({ accessToken });
      try {
        return { ...(await attempt()), refreshed: true };
      } catch (err2) {
        return { updated: false, reason: 'Contact score update failed', hubspotError: hubSpotErrorSummary(err2) };
      }
    }
    return { updated: false, reason: 'Contact score update failed', hubspotError: hubSpotErrorSummary(err) };
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

  async function ensureScoresWritten(dealScoreResult) {
    if (dealScoreResult?.updated || dealScoreResult?.scoresUpdated) {
      return { ...dealScoreResult, scoresUpdated: true, scoreTarget: 'deal' };
    }

    console.warn(
      '[HUBSPOT] Deal score write failed; trying CONTACT properties:',
      dealScoreResult?.scorePatchError || dealScoreResult?.hubspotError || dealScoreResult?.reason
    );
    const contactResult = await patchHubSpotContactScores(email, scoreProperties);
    if (contactResult?.updated) {
      return {
        ...dealScoreResult,
        updated: true,
        scoresUpdated: true,
        scoreTarget: 'contact',
        contactId: contactResult.contactId || dealScoreResult?.contactId,
      };
    }

    return {
      ...dealScoreResult,
      scoresUpdated: false,
      scoreTarget: null,
      contactScoreError: contactResult?.hubspotError || contactResult?.reason || null,
    };
  }

  async function patchScoresWithDealstage(stageId, logLabel) {
    const withStage = { ...scoreProperties, dealstage: stageId };
    console.log(`[HUBSPOT] ${logLabel} → PATCH deal (scores + dealstage):`, stageId);

    // patchHubSpotDealForEmail returns { updated:false } instead of throwing on API errors.
    const combined = await patchHubSpotDealForEmail(email, withStage);
    if (combined?.updated) {
      return { ...combined, scoresUpdated: true, stageUpdated: true, scoreTarget: 'deal' };
    }

    const combinedError = combined?.hubspotError || combined?.reason || 'unknown';
    console.warn('[HUBSPOT] Scores + stage PATCH failed; splitting updates:', combinedError);

    // 1) Scores alone — do not let a stage/pipeline issue block score writes
    const scoresOnly = await patchHubSpotDealForEmail(email, scoreProperties);
    if (!scoresOnly?.updated) {
      console.error(
        '[HUBSPOT] Deal score properties PATCH failed:',
        scoresOnly?.hubspotError || scoresOnly?.reason || 'unknown',
        scoreProperties
      );
    } else {
      console.log('[HUBSPOT] Deal score properties PATCH OK');
    }

    // 2) Stage alone
    const stageOnly = await patchHubSpotDealForEmail(email, { dealstage: stageId });
    if (!stageOnly?.updated) {
      console.error(
        '[HUBSPOT] dealstage-only PATCH failed:',
        stageOnly?.hubspotError || stageOnly?.reason || 'unknown'
      );
    } else {
      console.log('[HUBSPOT] dealstage-only PATCH OK:', stageId);
    }

    const splitResult = {
      updated: !!(scoresOnly?.updated || stageOnly?.updated),
      scoresUpdated: !!scoresOnly?.updated,
      stageUpdated: !!stageOnly?.updated,
      contactId: scoresOnly?.contactId || stageOnly?.contactId || combined?.contactId,
      dealId: scoresOnly?.dealId || stageOnly?.dealId || combined?.dealId,
      pipeline: stageOnly?.pipeline || scoresOnly?.pipeline || combined?.pipeline,
      previousDealStage: stageOnly?.previousDealStage || combined?.previousDealStage,
      dealstage: stageOnly?.dealstage || combined?.dealstage,
      combinedError,
      scorePatchError: scoresOnly?.updated
        ? null
        : scoresOnly?.hubspotError || scoresOnly?.reason || null,
      stagePatchError: stageOnly?.updated
        ? null
        : stageOnly?.hubspotError || stageOnly?.reason || null,
      scorePropertiesSkipped: !scoresOnly?.updated,
    };

    return ensureScoresWritten(splitResult);
  }

  /** Resolve configured stage (id or label); for pass, default label is "Acceptance Letter". */
  async function resolveStageForUpdate(rawConfigured, fallbackLabel) {
    const tokens = await getHubSpotTokens();
    if (!tokens?.access_token) throw new Error('HubSpot not connected');

    const hs = new hubspot.Client({ accessToken: tokens.access_token });
    const preferredPipeline = String(HUBSPOT_PIPELINE_ID || '').trim()
      ? await resolvePreferredPipelineId(hs)
      : null;

    const configured = String(rawConfigured || '').trim();
    if (configured) {
      const resolved = await resolveDealStageId(hs, preferredPipeline, configured);
      if (resolved) return resolved;
    }

    if (fallbackLabel) {
      const byLabel = await resolveDealStageId(hs, preferredPipeline, fallbackLabel);
      if (byLabel) return byLabel;
    }

    return null;
  }

  if (!passed) {
    const assessmentsStage = await resolveStageForUpdate(
      HUBSPOT_STAGE_ASSESSMENTS,
      'Assessments'
    );
    if (assessmentsStage) {
      return patchScoresWithDealstage(assessmentsStage, 'Quiz failed → assessments stage');
    }
    console.log('[HUBSPOT] Passed=false → dealstage unchanged (no assessments stage configured)');
    const scoresOnly = await patchHubSpotDealForEmail(email, scoreProperties);
    return ensureScoresWritten({ ...scoresOnly, scoresUpdated: !!scoresOnly?.updated });
  }

  // Passing the assessment → move deal to Acceptance Letter
  const acceptanceStage = await resolveStageForUpdate(
    HUBSPOT_STAGE_ACCEPTANCE_LETTER,
    'Acceptance Letter'
  );
  if (!acceptanceStage) {
    console.warn(
      '[HUBSPOT] Passed=true but could not resolve Acceptance Letter stage; updating scores only'
    );
    const scoresOnly = await patchHubSpotDealForEmail(email, scoreProperties);
    return {
      ...(await ensureScoresWritten({ ...scoresOnly, scoresUpdated: !!scoresOnly?.updated })),
      stageSkipped: true,
      reason: 'Acceptance Letter stage not found',
    };
  }

  return patchScoresWithDealstage(acceptanceStage, 'Quiz passed → Acceptance Letter');
}

/**
 * First quiz activity this attempt:
 * - If contact + deal exist → move deal to Assessments
 * - If contact missing → create contact, create deal in Assessments
 * - If contact exists but no deal → create deal in Assessments
 */
async function moveDealToAssessmentsStage(email, user = {}) {
  const configured = String(HUBSPOT_STAGE_ASSESSMENTS || '').trim();
  if (!configured) {
    console.warn('[HUBSPOT] Assessments stage move skipped: HUBSPOT_STAGE_ASSESSMENTS / HUBSPOT_ASSESSMENTS_STAGE_ID not set');
    return { updated: false, reason: 'Assessments stage ID not configured' };
  }

  const tokens = await getHubSpotTokens();
  if (!tokens?.access_token) throw new Error('HubSpot not connected');

  let accessToken = tokens.access_token;
  let hs = new hubspot.Client({ accessToken });

  async function run() {
    // Resolve stage → pipeline from HubSpot (do not trust HUBSPOT_PIPELINE_ID=default alone)
    let stageInfo = await resolveDealStage(hs, null, configured);
    if (!stageInfo) {
      stageInfo = await resolveDealStage(hs, null, 'Assessments');
    }
    if (!stageInfo?.stageId) {
      console.warn('[HUBSPOT] Assessments stage could not be resolved:', configured);
      return { updated: false, reason: 'Assessments stage not found in HubSpot pipelines' };
    }

    const properties = { dealstage: stageInfo.stageId };
    if (stageInfo.pipelineId) properties.pipeline = stageInfo.pipelineId;

    let contactId = await findContactIdByEmail(hs, email);
    let createdContact = false;
    if (!contactId) {
      contactId = await createContact(hs, {
        email,
        firstName: user?.firstName,
        lastName: user?.lastName,
        phone: user?.phone,
      });
      createdContact = true;
      if (!contactId) {
        return { updated: false, reason: 'Failed to create HubSpot contact' };
      }
    }

    const existingDeal = await findMostRecentDealForContact(hs, contactId, stageInfo.pipelineId || null);
    if (existingDeal?.dealId) {
      console.log('[HUBSPOT] Quiz started → moving existing deal to Assessments:', {
        contactId,
        dealId: existingDeal.dealId,
        properties,
      });
      await hs.crm.deals.basicApi.update(existingDeal.dealId, { properties });
      return {
        updated: true,
        createdContact,
        createdDeal: false,
        contactId,
        dealId: existingDeal.dealId,
        pipeline: properties.pipeline || existingDeal.pipeline,
        previousDealStage: existingDeal.dealstage,
        dealstage: properties.dealstage,
      };
    }

    // Not in the system (or no deal) → create deal already in Assessments
    const dealId = await createDealInAssessmentsStage(hs, {
      contactId,
      user: { ...user, email },
      stageId: stageInfo.stageId,
      pipelineId: stageInfo.pipelineId,
    });
    if (!dealId) {
      return { updated: false, reason: 'Failed to create HubSpot deal', contactId, createdContact };
    }

    return {
      updated: true,
      createdContact,
      createdDeal: true,
      contactId,
      dealId,
      pipeline: stageInfo.pipelineId,
      dealstage: stageInfo.stageId,
    };
  }

  try {
    return await run();
  } catch (err) {
    const msg = String(err?.message || err);
    console.error('[HUBSPOT] Assessments stage move failed:', hubSpotErrorSummary(err));
    if (msg.includes('401') || msg.toLowerCase().includes('unauthorized') || msg.toLowerCase().includes('expired')) {
      console.warn('[HUBSPOT] Unauthorized/expired. Refreshing token and retrying once…');
      accessToken = await refreshHubSpotToken();
      hs = new hubspot.Client({ accessToken });
      return { ...(await run()), refreshed: true };
    }
    throw err;
  }
}

module.exports = {
  updateHubSpotScores,
  moveDealToAssessmentsStage,
  saveHubSpotTokens,
  getHubSpotTokens,
  refreshHubSpotToken,
};
