import "dotenv/config";
import crypto from "node:crypto";
import { Redis } from "@upstash/redis";

const USERS_INDEX_KEY = "signal:users:index";
const CONFIRM_TOKEN_TTL_SECONDS = 60 * 60 * 24; // 24h

let redis;
function getRedis() {
  if (!redis) redis = Redis.fromEnv();
  return redis;
}

function userKey(email) {
  return `signal:user:${email.toLowerCase()}`;
}

function confirmKey(token) {
  return `signal:confirm:${token}`;
}

export async function listUsers() {
  const emails = await getRedis().smembers(USERS_INDEX_KEY);
  if (!emails.length) return [];
  const users = await Promise.all(emails.map((email) => getRedis().get(userKey(email))));
  return users.filter(Boolean);
}

export async function getUserByEmail(email) {
  return getRedis().get(userKey(email));
}

export async function upsertUser({
  email,
  companiesToTrack,
  industry,
  signals,
  otherSignal,
}) {
  const key = userKey(email);
  const existing = await getRedis().get(key);
  const record = {
    email,
    companiesToTrack: Array.isArray(companiesToTrack) ? companiesToTrack : [],
    industry,
    signals,
    otherSignal: otherSignal || "",
    // Re-signups keep whatever confirmation status they already had.
    confirmed: existing?.confirmed || false,
    createdAt: existing?.createdAt || new Date().toISOString(),
  };

  await getRedis().set(key, record);
  await getRedis().sadd(USERS_INDEX_KEY, email.toLowerCase());

  return record;
}

/** Creates a one-time confirmation token for an email, valid 24h. */
export async function createConfirmationToken(email) {
  const token = crypto.randomBytes(24).toString("hex");
  await getRedis().set(confirmKey(token), email.toLowerCase(), {
    ex: CONFIRM_TOKEN_TTL_SECONDS,
  });
  return token;
}

/** Marks the user tied to this token as confirmed. Returns the user, or null if the token is invalid/expired. */
export async function confirmEmailByToken(token) {
  const email = await getRedis().get(confirmKey(token));
  if (!email) return null;

  const key = userKey(email);
  const user = await getRedis().get(key);
  if (!user) return null;

  user.confirmed = true;
  await getRedis().set(key, user);
  await getRedis().del(confirmKey(token));

  return user;
}
