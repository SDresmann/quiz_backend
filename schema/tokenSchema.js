// schema/tokenSchema.js
const mongoose = require('mongoose');

const tokenSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true, unique: true }, // "hubspot"
    access_token: { type: String, default: '' },
    refresh_token: { type: String, default: '' },
    expires_in: Number,
    token_type: String,
    scope: String,
  },
  { timestamps: true }
);

// ✅ IMPORTANT: export a MODEL, not the schema
module.exports = mongoose.models.Token || mongoose.model('Token', tokenSchema);
