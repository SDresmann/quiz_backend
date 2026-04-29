const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const QuizAttempt = require('../schema/quizAttemptSchema');
const RetakeToken = require('../schema/retakeSchema');

const { FRONTEND_URL, PASS_URL, QUIZ_PASS_PERCENT, EMAIL_USER } = require('../config');

const { updateHubSpotScores, moveDealToAssessmentsStage } = require('../services/hubspotService');
const { sendPassFailEmailGraph, sendInternalQuizSectionSummaryEmail } = require('../services/emailService'); // Graph email

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


router.post('/quiz-progress', async (req, res) => {
  try {
    const { user, currentIndex, answers } = req.body;

    const email = normalizeEmail(user?.email);
    if (!email) return res.status(400).json({ error: 'Missing user.email' });

    const latest = await getLatestAttempt(email);


    if (latest?.status === 'completed') {
      console.warn('[PROGRESS] Blocked: latest attempt already completed for', email);
      return res.status(403).json({ error: 'Quiz is completed' });
    }

    const attemptNo = latest?.attemptNo ?? 1;

    const doc = await QuizAttempt.findOneAndUpdate(
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

    let hubspotAssessments = null;
    if (!doc.hubspotAssessmentsStageSet) {
      try {
        hubspotAssessments = await moveDealToAssessmentsStage(email);
        if (hubspotAssessments?.updated) {
          await QuizAttempt.updateOne(
            { email, attemptNo },
            { $set: { hubspotAssessmentsStageSet: true } }
          );
        }
      } catch (e) {
        console.error('[PROGRESS] HubSpot assessments stage failed:', e?.message || e);
        hubspotAssessments = { error: e?.message || String(e) };
      }
    }

    return res.json({ ok: true, hubspot: hubspotAssessments });
  } catch (e) {
    console.error('[ERROR] /api/quiz-progress crashed:', e);
    return res.status(500).json({ error: 'Server error', details: e?.message || String(e) });
  }
});


router.post('/retake/redeem', async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) return res.status(400).json({ error: 'Missing token' });

    const doc = await RetakeToken.findOne({ token });
    if (!doc) return res.status(404).json({ error: 'Invalid token' });

    if (doc.used) return res.status(403).json({ error: 'Token already used' });
    if (doc.expiresAt && doc.expiresAt.getTime() < Date.now())
      return res.status(403).json({ error: 'Token expired' });

    const email = normalizeEmail(doc.email);

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


router.post('/quiz-submission', async (req, res) => {
  console.log('[API] /api/quiz-submission hit');

  try {
    const {
      user,
      logical_reasoning,
      verbal_reasoning,
      numerical_reasoning,
      totalQuestions,
      logical_total,
      verbal_total,
      numerical_total,
      answers,
    } = req.body;

    console.log('[API] Incoming payload summary:', {
      email: user?.email,
      logical_reasoning,
      verbal_reasoning,
      numerical_reasoning,
      totalQuestions,
      logical_total,
      verbal_total,
      numerical_total,
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
    let lt = Number(logical_total);
    let vt = Number(verbal_total);
    let nt = Number(numerical_total);

    if ([lr, vr, nr, tq].some((n) => Number.isNaN(n))) {
      return res.status(400).json({ error: 'Invalid numeric values' });
    }
    if (tq <= 0) return res.status(400).json({ error: 'totalQuestions must be > 0' });

    if ([lt, vt, nt].some((n) => Number.isNaN(n) || n <= 0)) {
      if (tq % 3 === 0) {
        const per = tq / 3;
        lt = per;
        vt = per;
        nt = per;
        console.warn('[SCORE] Section totals missing/invalid; inferred equal thirds from totalQuestions:', {
          tq,
          per,
        });
      } else {
        return res.status(400).json({ error: 'Missing or invalid section totals (logical_total, verbal_total, numerical_total)' });
      }
    }

    if (lr > lt || vr > vt || nr > nt) {
      console.warn('[SCORE] Section correct counts exceed totals; clamping:', {
        lr,
        lt,
        vr,
        vt,
        nr,
        nt,
      });
    }
    const lrC = Math.min(Math.max(0, lr), lt);
    const vrC = Math.min(Math.max(0, vr), vt);
    const nrC = Math.min(Math.max(0, nr), nt);

    const totalCorrect = lrC + vrC + nrC;
    const percent = Math.round((totalCorrect / tq) * 100);
    const passed = percent >= QUIZ_PASS_PERCENT;

    console.log('[SCORE] Computed:', {
      email,
      lr: lrC,
      vr: vrC,
      nr: nrC,
      totalCorrect,
      tq,
      percent,
      passThreshold: QUIZ_PASS_PERCENT,
      passed,
    });
    console.log('[SCORE] Section mapping:', {
      logical_reasoning: lrC,
      verbal_reasoning: vrC,
      numerical_reasoning: nrC,
    });


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
          logical_reasoning: lrC,
          verbal_reasoning: vrC,
          numerical_reasoning: nrC,
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

    let hubspotResult = null;
    try {
      console.log('[FLOW] Updating HubSpot DEAL fields...');
      console.log('[FLOW] HubSpot payload preview:', {
        email,
        scores: {
          logical_reasoning: lrC,
          verbal_reasoning: vrC,
          numerical_reasoning: nrC,
        },
        passed,
      });
      hubspotResult = await updateHubSpotScores(
        email,
        {
          logical_reasoning: lrC,
          verbal_reasoning: vrC,
          numerical_reasoning: nrC,
        },
        passed
      );
      console.log('[FLOW] HubSpot update result:', hubspotResult);
    } catch (hubspotErr) {
      console.error('[FLOW] HubSpot update failed (quiz result still saved):', hubspotErr?.message || hubspotErr);
      hubspotResult = { error: hubspotErr?.message || String(hubspotErr) };
    }

    let emailSent = false;
    if (!passed) {
      try {
        console.log('[FLOW] Sending fail email…');
        await sendPassFailEmailGraph({
          toEmail: email,
          firstName: user?.firstName || '',
          percent,
          passed,
          retakeUrl,
          passUrl,
        });
        emailSent = true;
        console.log('[FLOW] Fail email sent.');
      } catch (emailErr) {
        console.error('[FLOW] Fail email send failed (quiz result still saved):', emailErr?.message || emailErr);
      }
    } else {
      console.log('[FLOW] Skipping candidate pass email.');
    }

    let internalSummaryResult = { sent: false, reason: 'not_attempted' };
    try {
      console.log('[FLOW] Sending internal section summary...', { toEmail: EMAIL_USER });
      internalSummaryResult = await sendInternalQuizSectionSummaryEmail({
        toEmail: EMAIL_USER,
        candidate: {
          firstName: user?.firstName || '',
          lastName: user?.lastName || '',
          email,
          phone: user?.phone || '',
        },
        scores: { logical: lrC, verbal: vrC, numerical: nrC },
        totals: { logical: lt, verbal: vt, numerical: nt },
        percent,
        passed,
      });
      console.log('[FLOW] Internal summary email result:', internalSummaryResult);
    } catch (internalEmailErr) {
      console.error('[FLOW] Internal summary email failed (quiz result still saved):', internalEmailErr?.message || internalEmailErr);
      internalSummaryResult = { sent: false, error: internalEmailErr?.message || String(internalEmailErr) };
    }

    console.log('[FLOW] Done.');
    return res.json({
      ok: true,
      percent,
      passed,
      hubspot: hubspotResult,
      retakeUrl,
      passUrl,
      emailSent,
      internalSummaryEmailSent: !!internalSummaryResult?.sent,
      internalSummaryEmailChannel: internalSummaryResult?.via || null,
      internalSummaryRecipient: EMAIL_USER || null,
      internalSummaryEmailInfo: internalSummaryResult,
    });
  } catch (err) {
    console.error('[ERROR] quiz-submission crashed:', err);
    return res.status(500).json({ error: 'Server error', details: err?.message || String(err) });
  }
});

module.exports = router;
