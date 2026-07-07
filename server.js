import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { upsertUser, getUserByEmail } from "./src/store.js";
import { runAgentForUser } from "./src/agent.js";
import {
  sendSignalEmail,
  sendSignupNotification,
  isEmailSendingConfigured,
} from "./src/mailer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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

    res.json({ ok: true, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong saving your signup." });
  }
});

app.post("/api/run", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "email is required" });

    const user = await getUserByEmail(email);
    if (!user) return res.status(404).json({ error: "No signup found for that email yet." });

    console.log(`[agent] running scan for ${user.email} (${user.industry})...`);
    const result = await runAgentForUser(user);
    console.log(
      `[agent] done. ${result.alerts.length} alert(s), ${result.sourcesSearched.length} source(s) searched.`
    );

    let emailSent = false;
    let emailError = null;
    if (isEmailSendingConfigured()) {
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

    res.json({ ok: true, result: { ...result, emailSent, emailError } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "The agent run failed." });
  }
});

app.listen(PORT, () => {
  console.log(`Signal running at http://localhost:${PORT}`);
});
