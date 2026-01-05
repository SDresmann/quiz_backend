// routes/quizRoutes.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const QuizAttempt = require('../schema/quizAttemptSchema');
const RetakeToken = require('../schema/retakeSchema');

const { FRONTEND_URL, PASS_URL } = require('../config');

// ✅ services
const { updateHubSpotScores } = require('../services/hubspotService'); // should update DEAL now
const { sendPassFailEmailGraph } = require('../services/emailService'); // Graph email

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

async function getLatestAttempt(email) {
  return await QuizAttempt.findOne({ email }).sort({ createdAt: -1 }).lean();
}

async function createRetakeToken(email) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24); // 24 hours
  await RetakeToken.create({ token, email, expiresAt, used: false });
  return token;
}

/**
 * GET /api/quiz-attempt?email=...
 * Used by frontend on load to see if user already has an attempt saved.
 */
router.get('/quiz-attempt', async (req, res) => {
  try {
    const email = normalizeEmail(req.query.email);
    if (!email) return res.status(400).json({ error: 'Missing email' });

    const attempt = await getLatestAttempt(email);
    if (!attempt) return res.json({ exists: false });

    return res.json({
      exists: true,
      status: attempt.status,
      attemptNo: attempt.attemptNo,
      currentIndex: attempt.currentIndex ?? 0,
      answers: attempt.answers ?? {},
      user: attempt.user ?? null,
      result: attempt.result ?? null,
    });
  } catch (err) {
    console.error('[API] /api/quiz-attempt crashed:', err);
    return res.status(500).json({ error: 'Server error', details: err?.message || String(err) });
  }
});

/**
 * POST /api/quiz-progress
 * Saves progress while user is taking the quiz (prevents re-taking without retake token)
 */
router.post('/quiz-progress', async (req, res) => {
  try {
    const { user, currentIndex, answers } = req.body;

    const email = normalizeEmail(user?.email);
    if (!email) return res.status(400).json({ error: 'Missing user.email' });

    const latest = await getLatestAttempt(email);

    // If latest attempt is already completed, block saving progress (prevents re-starting)
    if (latest?.status === 'completed') {
      console.warn('[PROGRESS] Blocked: latest attempt already completed for', email);
      return res.status(403).json({ error: 'Quiz is completed' });
    }

    const attemptNo = latest?.attemptNo ?? 1;

    await QuizAttempt.findOneAndUpdate(
      { email, attemptNo },
      {
        email,
        attemptNo,
        user: {
          firstName: user?.firstName || '',
          lastName: user?.lastName || '',
          email,
          phone: user?.phone || '',
        },
        status: 'in_progress',
        currentIndex: Number.isFinite(Number(currentIndex)) ? Number(currentIndex) : 0,
        answers: answers && typeof answers === 'object' ? answers : {},
      },
      { upsert: true, new: true }
    );

    console.log('[PROGRESS] Saved progress:', { email, attemptNo, currentIndex });
    return res.json({ ok: true });
  } catch (e) {
    console.error('[ERROR] /api/quiz-progress crashed:', e);
    return res.status(500).json({ error: 'Server error', details: e?.message || String(e) });
  }
});

/**
 * POST /api/retake/redeem
 * Redeems a token from the "try again" email, and creates a new attempt.
 * Body: { token }
 */
router.post('/retake/redeem', async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) return res.status(400).json({ error: 'Missing token' });

    const doc = await RetakeToken.findOne({ token });
    if (!doc) return res.status(404).json({ error: 'Invalid token' });

    if (doc.used) return res.status(403).json({ error: 'Token already used' });
    if (doc.expiresAt && doc.expiresAt.getTime() < Date.now()) return res.status(403).json({ error: 'Token expired' });

    const email = normalizeEmail(doc.email);

    // mark token as used
    doc.used = true;
    doc.usedAt = new Date();
    await doc.save();

    const latest = await getLatestAttempt(email);
    const nextAttemptNo = (latest?.attemptNo ?? 0) + 1;

    await QuizAttempt.create({
      email,
      attemptNo: nextAttemptNo,
      user: latest?.user ?? { email },
      status: 'in_progress',
      currentIndex: 0,
      answers: {},
    });

    console.log('[RETAKE] Redeemed token. New attempt created:', { email, attemptNo: nextAttemptNo });

    return res.json({ ok: true, email, attemptNo: nextAttemptNo });
  } catch (e) {
    console.error('[ERROR] /api/retake/redeem crashed:', e);
    return res.status(500).json({ error: 'Server error', details: e?.message || String(e) });
  }
});

/**
 * POST /api/quiz-submission
 * Final submit.
 * - computes overall percent
 * - updates HubSpot DEAL scores (service)
 * - sends pass/fail email (Graph)
 * - if fail => generates retake token + url
 * - if pass => sends PASS_URL in email
 */
router.post('/quiz-submission', async (req, res) => {
  console.log('[API] /api/quiz-submission hit');

  try {
    const {
      user,
      logical_reasoning,
      verbal_reasoning,
      numerical_reasoning,
      totalQuestions,
      answers,
    } = req.body;

    console.log('[API] Incoming payload summary:', {
      email: user?.email,
      logical_reasoning,
      verbal_reasoning,
      numerical_reasoning,
      totalQuestions,
      answersCount: answers ? Object.keys(answers).length : 0,
    });

    if (!user?.email) return res.status(400).json({ error: 'Missing user.email' });

    const email = normalizeEmail(user.email);

    const latest = await getLatestAttempt(email);
    if (latest?.status === 'completed') {
      console.warn('[SUBMIT] Blocked: quiz already completed for', email);
      return res.status(403).json({ error: 'Quiz already completed' });
    }

    const attemptNo = latest?.attemptNo ?? 1;

    const lr = Number(logical_reasoning);
    const vr = Number(verbal_reasoning);
    const nr = Number(numerical_reasoning);
    const tq = Number(totalQuestions);

    if ([lr, vr, nr, tq].some((n) => Number.isNaN(n))) {
      return res.status(400).json({ error: 'Invalid numeric values' });
    }
    if (tq <= 0) return res.status(400).json({ error: 'totalQuestions must be > 0' });

    const totalCorrect = lr + vr + nr;
    const percent = Math.round((totalCorrect / tq) * 100);
    const passed = percent >= 60;

    console.log('[SCORE] Computed:', { lr, vr, nr, totalCorrect, tq, percent, passed });

    // Save final attempt
    await QuizAttempt.findOneAndUpdate(
      { email, attemptNo },
      {
        email,
        attemptNo,
        user: {
          firstName: user?.firstName || '',
          lastName: user?.lastName || '',
          email,
          phone: user?.phone || '',
        },
        status: 'completed',
        answers: answers && typeof answers === 'object' ? answers : {},
        currentIndex: Math.max(0, tq - 1),
        result: {
          logical_reasoning: lr,
          verbal_reasoning: vr,
          numerical_reasoning: nr,
          totalQuestions: tq,
          percent,
          passed,
          submittedAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );

    let retakeUrl = null;
    let passUrl = null;

    if (passed) {
      passUrl = PASS_URL || null;
      console.log('[PASS] passUrl:', passUrl);
    } else {
      const token = await createRetakeToken(email);
      retakeUrl = `${FRONTEND_URL}/?retake=${encodeURIComponent(token)}`;
      console.log('[RETAKE] Generated retakeUrl:', retakeUrl);
    }

    console.log('[FLOW] Updating HubSpot DEAL fields...');
    const hubspotResult = await updateHubSpotScores(email, {
      logical_reasoning: lr,
      verbal_reasoning: vr,
      numerical_reasoning: nr,
      percent,
      passed,
    });
    console.log('[FLOW] HubSpot update result:', hubspotResult);

    console.log('[FLOW] Sending pass/fail email…');
    await sendPassFailEmailGraph({
      toEmail: email,
      firstName: user?.firstName || '',
      percent,
      passed,
      retakeUrl,
      passUrl,
    });

    console.log('[FLOW] Done.');
    return res.json({ ok: true, percent, passed, hubspot: hubspotResult, retakeUrl, passUrl });
  } catch (err) {
    console.error('[ERROR] quiz-submission crashed:', err);
    return res.status(500).json({ error: 'Server error', details: err?.message || String(err) });
  }
});

module.exports = router;
