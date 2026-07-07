import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  upsertUser,
  getUserByEmail,
  listUsers,
  createConfirmationToken,
  confirmEmailByToken,
} from "./src/store.js";
import { runAgentForUser, runResearchPhase, runDraftPhase } from "./src/agent.js";
import {
  sendSignalEmail,
  sendSignupNotification,
  sendConfirmationEmail,
  isEmailSendingConfigured,
} from "./src/mailer.js";
import {
  isQueueConfigured,
  enqueueResearch,
  enqueueDraft,
  verifyQStashRequest,
} from "./src/queue.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3002;

// Keep the raw bytes alongside the parsed body — QStash's signature check
// needs the exact original payload, not a re-serialized copy of req.body.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString(); } }));
app.use(express.static(path.join(__dirname, "public")));

// Vercel's free tier kills a serverless function after 60s. A real
// research + draft run can take longer than that combined, so on Vercel
// (with the real API, not mock) each phase runs as its own QStash-triggered
// request instead of one long request the caller waits on.
function shouldUseQueue() {
  return Boolean(process.env.VERCEL) && process.env.MOCK_AGENT !== "true" && isQueueConfigured();
}

// Safe to expose: booleans only, never the actual secret values. Lets us
// confirm what's configured in a given environment without spending
// anything or guessing from error messages.
app.get("/api/status", (req, res) => {
  res.json({
    mockAgent: process.env.MOCK_AGENT === "true",
    anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
    resendConfigured: isEmailSendingConfigured(),
    ownerEmailConfigured: Boolean(process.env.OWNER_EMAIL),
    cronSecretConfigured: Boolean(process.env.CRON_SECRET),
    redisConfigured: Boolean(
      process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ),
    queueConfigured: isQueueConfigured(),
    usingQueueForRuns: shouldUseQueue(),
    // Temporary debug fields — safe (URL isn't secret; token shows only a
    // short prefix, not enough to reconstruct it). Remove once QStash works.
    qstashUrl: process.env.QSTASH_URL || null,
    qstashTokenPrefix: process.env.QSTASH_TOKEN?.slice(0, 12) || null,
    qstashTokenLength: process.env.QSTASH_TOKEN?.length || 0,
  });
});

app.post("/api/signup", async (req, res) => {
  try {
    const { email, companiesToTrack, industry, signals, otherSignal } = req.body;

    if (!email || !industry || !Array.isArray(signals) || signals.length === 0) {
      return res
        .status(400)
        .json({ error: "email, industry, and at least one signal are required" });
    }

    if (signals.includes("other") && !otherSignal) {
      return res
        .status(400)
        .json({ error: 'otherSignal is required when "other" is selected' });
    }

    const user = await upsertUser({
      email,
      companiesToTrack,
      industry,
      signals,
      otherSignal,
    });

    if (isEmailSendingConfigured() && process.env.OWNER_EMAIL) {
      try {
        await sendSignupNotification({ ownerEmail: process.env.OWNER_EMAIL, signup: user });
        console.log(`[mailer] signup notification sent for ${user.email}`);
      } catch (err) {
        console.error("[mailer] signup notification failed:", err);
      }
    }

    if (isEmailSendingConfigured() && !user.confirmed) {
      try {
        const token = await createConfirmationToken(user.email);
        const confirmUrl = `${req.protocol}://${req.get("host")}/api/confirm?token=${token}`;
        await sendConfirmationEmail({ to: user.email, confirmUrl });
        console.log(`[mailer] confirmation email sent for ${user.email}`);
      } catch (err) {
        console.error("[mailer] confirmation email failed:", err);
      }
    }

    res.json({ ok: true, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong saving your signup." });
  }
});

app.get("/api/confirm", async (req, res) => {
  const { token } = req.query;
  const user = token ? await confirmEmailByToken(token) : null;

  res
    .status(user ? 200 : 400)
    .send(
      `<!DOCTYPE html><html><body style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 80px auto; text-align: center; color: #1c1b18;">${
        user
          ? `<h1 style="font-size: 20px;">You're confirmed.</h1><p>Signal will run for ${user.email} whenever you click "Run now."</p>`
          : `<h1 style="font-size: 20px;">That link didn't work.</h1><p>It may have expired (links are valid 24h) or already been used. Sign up again to get a fresh one.</p>`
      }</body></html>`
    );
});

// Shared by the manual "run now" button and the daily cron. Only actually
// sends an email when the agent found something genuinely worth sending —
// an empty scan stays silent instead of mailing a "nothing today" note.
async function runAndMaybeSend(user) {
  console.log(`[agent] running scan for ${user.email} (${user.industry})...`);
  const result = await runAgentForUser(user);
  console.log(
    `[agent] done. ${result.alerts.length} alert(s), ${result.sourcesSearched.length} source(s) searched.`
  );

  let emailSent = false;
  let emailError = null;
  if (isEmailSendingConfigured() && result.alerts.length > 0) {
    try {
      await sendSignalEmail({
        to: user.email,
        subject: result.email_subject,
        html: result.email_html,
      });
      emailSent = true;
      console.log(`[mailer] sent to ${user.email}`);
    } catch (err) {
      emailError = err.message;
      console.error("[mailer] failed:", err);
    }
  }

  return { ...result, emailSent, emailError };
}

app.post("/api/run", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "email is required" });

    const user = await getUserByEmail(email);
    if (!user) return res.status(404).json({ error: "No signup found for that email yet." });

    if (isEmailSendingConfigured() && !user.confirmed) {
      return res
        .status(403)
        .json({ error: "Please confirm your email first — check your inbox for the link." });
    }

    if (shouldUseQueue()) {
      const baseUrl = `${req.protocol}://${req.get("host")}`;
      await enqueueResearch({ email: user.email, baseUrl });
      console.log(`[queue] research enqueued for ${user.email}`);
      return res.json({ ok: true, queued: true });
    }

    const result = await runAndMaybeSend(user);
    res.json({ ok: true, result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "The agent run failed." });
  }
});

// Vercel Cron hits this once a day (see vercel.json). Vercel attaches
// `Authorization: Bearer $CRON_SECRET` automatically when CRON_SECRET is set
// as an env var, so this rejects anyone else who finds the URL.
app.get("/api/cron", async (req, res) => {
  if (process.env.CRON_SECRET) {
    const expected = `Bearer ${process.env.CRON_SECRET}`;
    if (req.headers.authorization !== expected) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const users = await listUsers();
  const confirmed = users.filter((u) => u.confirmed);
  console.log(`[cron] running for ${confirmed.length} confirmed user(s)`);

  if (shouldUseQueue()) {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    for (const user of confirmed) {
      try {
        await enqueueResearch({ email: user.email, baseUrl });
      } catch (err) {
        console.error(`[cron] failed to enqueue ${user.email}:`, err);
      }
    }
    return res.json({ ok: true, queued: confirmed.length });
  }

  const summary = [];
  for (const user of confirmed) {
    try {
      const result = await runAndMaybeSend(user);
      summary.push({ email: user.email, alerts: result.alerts.length, emailSent: result.emailSent });
    } catch (err) {
      console.error(`[cron] failed for ${user.email}:`, err);
      summary.push({ email: user.email, error: err.message });
    }
  }

  res.json({ ok: true, ranFor: confirmed.length, summary });
});

// QStash calls these back; each is its own short-lived request so neither
// one risks hitting Vercel's per-invocation time limit.
app.post("/api/worker/research", async (req, res) => {
  try {
    await verifyQStashRequest(req);
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }

  const { email } = req.body;
  try {
    const user = await getUserByEmail(email);
    if (!user) throw new Error(`No signup found for ${email}`);

    console.log(`[worker/research] running for ${email}...`);
    const { findingsText, sourcesSearched } = await runResearchPhase(user);
    console.log(`[worker/research] done for ${email}, ${sourcesSearched.length} source(s)`);

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    await enqueueDraft({ email, findingsText, sourcesSearched, baseUrl });
    res.json({ ok: true });
  } catch (err) {
    console.error(`[worker/research] failed for ${email}:`, err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/worker/draft", async (req, res) => {
  try {
    await verifyQStashRequest(req);
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }

  const { email, findingsText, sourcesSearched } = req.body;
  try {
    const user = await getUserByEmail(email);
    if (!user) throw new Error(`No signup found for ${email}`);

    console.log(`[worker/draft] running for ${email}...`);
    const parsed = await runDraftPhase(user, findingsText);
    console.log(`[worker/draft] done for ${email}, ${parsed.alerts.length} alert(s)`);

    if (isEmailSendingConfigured() && parsed.alerts.length > 0) {
      await sendSignalEmail({ to: email, subject: parsed.email_subject, html: parsed.email_html });
      console.log(`[mailer] sent to ${email}`);
    }

    res.json({ ok: true, sourcesSearched });
  } catch (err) {
    console.error(`[worker/draft] failed for ${email}:`, err);
    res.status(500).json({ error: err.message });
  }
});

// Vercel imports `app` and handles the HTTP server itself; everywhere else
// (local dev, Render) we need to listen on a port ourselves.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Signal running at http://localhost:${PORT}`);
  });
}

export default app;
