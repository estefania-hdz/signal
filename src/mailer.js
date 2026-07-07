import "dotenv/config";
import { Resend } from "resend";

// Constructed lazily so the server can boot without RESEND_API_KEY set —
// sending is skipped (not thrown) until a key is configured.
let client;
function getClient() {
  if (!client) client = new Resend(process.env.RESEND_API_KEY);
  return client;
}

export function isEmailSendingConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
}

/**
 * Sends the generated brief to the subscriber via Resend.
 * Uses Resend's shared sandbox sender, which works without verifying a
 * custom domain — good enough to see a real email land in a real inbox.
 */
export async function sendSignalEmail({ to, subject, html }) {
  const { data, error } = await getClient().emails.send({
    from: "Signal <onboarding@resend.dev>",
    to,
    subject,
    html,
  });

  if (error) {
    throw new Error(error.message || "Resend failed to send the email");
  }

  return data;
}

/**
 * Notifies the product owner that someone signed up — so there's a way to
 * know the landing page is actually being used, without building a dashboard.
 */
export async function sendSignupNotification({ ownerEmail, signup }) {
  const companies = (signup.companiesToTrack || []).map((c) => c.name).join(", ") || "none";
  const signals = (signup.signals || []).join(", ") + (signup.otherSignal ? ` (${signup.otherSignal})` : "");

  const { data, error } = await getClient().emails.send({
    from: "Signal <onboarding@resend.dev>",
    to: ownerEmail,
    subject: `New Signal signup: ${signup.email}`,
    html: `<div style="font-family: -apple-system, Helvetica, Arial, sans-serif; max-width: 480px; padding: 16px;">
      <p style="font-size: 15px;"><strong>New signup on Signal</strong></p>
      <ul style="font-size: 14px; line-height: 1.6;">
        <li><strong>Email:</strong> ${signup.email}</li>
        <li><strong>Watching:</strong> ${signup.industry}</li>
        <li><strong>Companies to track:</strong> ${companies}</li>
        <li><strong>Signals:</strong> ${signals}</li>
        <li><strong>Signed up at:</strong> ${signup.createdAt}</li>
      </ul>
    </div>`,
  });

  if (error) {
    throw new Error(error.message || "Resend failed to send the signup notification");
  }

  return data;
}

/**
 * Sends the one-click confirmation link a new subscriber needs to click
 * before Signal will run a scan for them — keeps random/typo'd emails and
 * spammed "run now" clicks from spending real API credit.
 */
export async function sendConfirmationEmail({ to, confirmUrl }) {
  const { data, error } = await getClient().emails.send({
    from: "Signal <onboarding@resend.dev>",
    to,
    subject: "Confirm your Signal subscription",
    html: `<div style="font-family: -apple-system, Helvetica, Arial, sans-serif; max-width: 480px; padding: 16px; color: #1c1b18;">
      <p style="font-size: 15px; line-height: 1.6;">One click and your watch is live.</p>
      <p style="margin: 20px 0;">
        <a href="${confirmUrl}" style="display: inline-block; background: #1F6F63; color: #fff; padding: 12px 22px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">Confirm my email</a>
      </p>
      <p style="font-size: 13px; color: #6B6656;">If you didn't sign up for Signal, you can safely ignore this — nothing runs until this link is clicked.</p>
    </div>`,
  });

  if (error) {
    throw new Error(error.message || "Resend failed to send the confirmation email");
  }

  return data;
}
