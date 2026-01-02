import mongoose from 'mongoose';
export const quizSubmissionSchema = new mongoose.Schema(
    {
      user: {
        firstName: String,
        lastName: String,
        email: { type: String, index: true },
        phone: String,
      },
      answers: mongoose.Schema.Types.Mixed,
      score: Number,
      hubspotId: String,
    },
    { timestamps: true }
  );