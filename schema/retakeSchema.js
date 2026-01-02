const mongoose = require('mongoose');

const RetakeTokenSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true, index: true },
    email: { type: String, required: true, index: true },
    used: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true, index: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// TTL cleanup (Mongo will remove docs after expiresAt)
RetakeTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('RetakeToken', RetakeTokenSchema);
