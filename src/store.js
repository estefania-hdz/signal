import "dotenv/config";
import { Redis } from "@upstash/redis";

const USERS_INDEX_KEY = "signal:users:index";

let redis;
function getRedis() {
  if (!redis) redis = Redis.fromEnv();
  return redis;
}

function userKey(email) {
  return `signal:user:${email.toLowerCase()}`;
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
    createdAt: existing?.createdAt || new Date().toISOString(),
  };

  await getRedis().set(key, record);
  await getRedis().sadd(USERS_INDEX_KEY, email.toLowerCase());

  return record;
}
