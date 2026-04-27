require('dotenv').config();


const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const quizRoutes = require('./routes/quizRoutes');
const authRoutes = require('./routes/authRoutes');
const Token = require('./schema/tokenSchema');

const {
  PORT,
  MONGO_URI,
  BASE_URL,
  FRONTEND_URL,
  PASS_URL,
  HUBSPOT_REDIRECT_URI,
  isGraphEmailConfigured,
  GRAPH_CLIENT_ID,
  GRAPH_CLIENT_SECRET,
  GRAPH_TENANT_ID,
  GRAPH_SENDER_EMAIL,
  CORS_EXTRA_ORIGINS,
} = require('./config');

const app = express();
const corsOrigins = ['http://localhost:3000'];
if (FRONTEND_URL && !corsOrigins.includes(FRONTEND_URL)) corsOrigins.push(FRONTEND_URL);
for (const o of CORS_EXTRA_ORIGINS || []) {
  if (o && !corsOrigins.includes(o)) corsOrigins.push(o);
}
// Common Render hosting for this repo's CRA app (safe default; override via CORS_EXTRA_ORIGINS)
if (!corsOrigins.includes('https://kable-quiz.onrender.com')) {
  corsOrigins.push('https://kable-quiz.onrender.com');
}
app.use(cors({ origin: corsOrigins }));
app.use(express.json());
if (HUBSPOT_REDIRECT_URI) console.log('[BOOT] HubSpot redirect_uri:', HUBSPOT_REDIRECT_URI);
// Log all Render-critical env (for debugging – values are never logged)
console.log('[BOOT] Env check:', {
  FRONTEND_URL: FRONTEND_URL ? 'set' : 'MISSING',
  BASE_URL: BASE_URL ? 'set' : 'MISSING',
  MONGO_URI: MONGO_URI ? 'set' : 'MISSING',
  PASS_URL: PASS_URL ? 'set' : 'MISSING',
  GRAPH_CLIENT_ID: GRAPH_CLIENT_ID ? 'set' : 'MISSING',
  GRAPH_CLIENT_SECRET: GRAPH_CLIENT_SECRET ? 'set' : 'MISSING',
  GRAPH_TENANT_ID: GRAPH_TENANT_ID ? 'set' : 'MISSING',
  GRAPH_SENDER_EMAIL: GRAPH_SENDER_EMAIL ? 'set' : 'MISSING',
  emailConfigured: isGraphEmailConfigured(),
});


mongoose
  .connect(MONGO_URI)
  .then(() => console.log('[MONGO] Connected'))
  .catch((err) => {
    console.error('[MONGO] Connection failed', err);
    process.exit(1);
  });


app.use('/api/auth', authRoutes);
app.use('/api/quiz', quizRoutes);

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true });
});

app.get('/api/hubspot-status', async (req, res) => {
  try {
    const doc = await Token.findOne({ provider: 'hubspot' }).lean();
    const hasAccess = !!(doc && doc.access_token);
    const hasRefresh = !!(doc && doc.refresh_token);
    return res.json({
      ok: true,
      hubspotTokenRowExists: !!doc,
      hasAccessToken: hasAccess,
      hasRefreshToken: hasRefresh,
      updatedAt: doc?.updatedAt || null,
      scope: doc?.scope || null,
      redirectUriConfigured: !!HUBSPOT_REDIRECT_URI,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get('/api/email-status', (req, res) => {
  res.json({ configured: isGraphEmailConfigured() });
});




app.listen(PORT, () => {
  console.log(`[BOOT] Server running on port ${PORT}`);
});