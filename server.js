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
import { runAgentForUser } from "./src/agent.js";
import {
  sendSignalEmail,
  sendSignupNotification,
  sendConfirmationEmail,
  isEmailSendingConfigured,
} from "./src/mailer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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

    const result = await runAndMaybeSend(user);
    res.json({ ok: true, result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "The agent run failed." });
  }
});

// Hit once a day by an external scheduler (see README — Render Cron Job,
// GitHub Actions, cron-job.org). CRON_SECRET, when set, is checked as a
// bearer token so only that scheduler can trigger it.
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

app.listen(PORT, () => {
  console.log(`Signal running at http://localhost:${PORT}`);
});

export default app;
