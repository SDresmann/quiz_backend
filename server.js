require('dotenv').config();


const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const quizRoutes = require('./routes/quizRoutes');
const authRoutes = require('./routes/authRoutes');

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
} = require('./config');

const app = express();
const corsOrigins = ['http://localhost:3000'];
if (FRONTEND_URL && !corsOrigins.includes(FRONTEND_URL)) corsOrigins.push(FRONTEND_URL);
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

app.get('/api/email-status', (req, res) => {
  res.json({ configured: isGraphEmailConfigured() });
});




app.listen(PORT, () => {
  console.log(`[BOOT] Server running on port ${PORT}`);
});