require('dotenv').config()

const PORT = process.env.PORT || 4000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const PASS_URL = process.env.PASS_URL

const MONGO_URI = process.env.MONGO_URI;


const HUBSPOT_CLIENT_ID = process.env.HUBSPOT_CLIENT_ID;
const HUBSPOT_CLIENT_SECRET =
  process.env.HUBSPOT_CLIENT_SECRET || process.env.HUBSPOT_CLIENT_SERCRET;
const HUBSPOT_REDIRECT_URI =
  process.env.HUBSPOT_REDIRECT_URI || `${BASE_URL}/auth/callback`; 

const GRAPH_CLIENT_ID = process.env.GRAPH_CLIENT_ID;
const GRAPH_CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET;
const GRAPH_TENANT_ID = process.env.GRAPH_TENANT_ID;
const GRAPH_SENDER_EMAIL = process.env.GRAPH_SENDER_EMAIL;

module.exports = {
    PORT,
    BASE_URL,
    FRONTEND_URL,
    MONGO_URI,
    PASS_URL,
  
    HUBSPOT_CLIENT_ID,
    HUBSPOT_CLIENT_SECRET,
    HUBSPOT_REDIRECT_URI,
  
    GRAPH_CLIENT_ID,
    GRAPH_CLIENT_SECRET,
    GRAPH_TENANT_ID,
    GRAPH_SENDER_EMAIL,
  };