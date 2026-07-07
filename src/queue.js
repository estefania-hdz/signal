import "dotenv/config";
import { Client, Receiver } from "@upstash/qstash";

let qstashClient;
function getQstashClient() {
  if (!qstashClient) qstashClient = new Client({ token: process.env.QSTASH_TOKEN });
  return qstashClient;
}

let receiver;
function getReceiver() {
  if (!receiver) {
    receiver = new Receiver({
      currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
      nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
    });
  }
  return receiver;
}

export function isQueueConfigured() {
  return Boolean(process.env.QSTASH_TOKEN);
}

// On Vercel's free tier, a serverless function is killed after 60s. A real
// research-then-draft run can take longer than that combined, so each phase
// runs as its own QStash-triggered request instead of one long request the
// user's browser waits on.
export async function enqueueResearch({ email, baseUrl }) {
  await getQstashClient().publishJSON({
    url: `${baseUrl}/api/worker/research`,
    body: { email },
  });
}

export async function enqueueDraft({ email, findingsText, sourcesSearched, baseUrl }) {
  await getQstashClient().publishJSON({
    url: `${baseUrl}/api/worker/draft`,
    body: { email, findingsText, sourcesSearched },
  });
}

/** Throws if the request isn't a genuine, signed QStash callback. */
export async function verifyQStashRequest(req) {
  const signature = req.headers["upstash-signature"];
  if (!signature) throw new Error("Missing QStash signature");
  const isValid = await getReceiver().verify({ signature, body: req.rawBody });
  if (!isValid) throw new Error("Invalid QStash signature");
}
