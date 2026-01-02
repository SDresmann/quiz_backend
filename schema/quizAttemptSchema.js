const mongoose = require('mongoose');

const QuizAttemptSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, index: true },
    attemptNo: { type: Number, required: true, default: 1 },

    user: {
      firstName: String,
      lastName: String,
      email: String,
      phone: String,
    },

    status: { type: String, enum: ['in_progress', 'completed'], default: 'in_progress' },
    currentIndex: { type: Number, default: 0 },
    answers: { type: Object, default: {} },

    result: {
      logical_reasoning: Number,
      verbal_reasoning: Number,
      numerical_reasoning: Number,
      totalQuestions: Number,
      percent: Number,
      passed: Boolean,
      submittedAt: Date,
    },
  },
  { timestamps: true }
);

// Make "latest attempt per email" easy
QuizAttemptSchema.index({ email: 1, attemptNo: -1 }, { unique: true });

module.exports = mongoose.model('QuizAttempt', QuizAttemptSchema);
