import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USERS_PATH = path.join(__dirname, "..", "data", "users.json");

async function readUsers() {
  try {
    const raw = await readFile(USERS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function writeUsers(users) {
  await writeFile(USERS_PATH, JSON.stringify(users, null, 2) + "\n", "utf-8");
}

export async function listUsers() {
  return readUsers();
}

export async function getUserByEmail(email) {
  const users = await readUsers();
  return users.find((u) => u.email.toLowerCase() === email.toLowerCase());
}

export async function upsertUser({
  email,
  companiesToTrack,
  industry,
  signals,
  otherSignal,
}) {
  const users = await readUsers();
  const existingIndex = users.findIndex(
    (u) => u.email.toLowerCase() === email.toLowerCase()
  );
  const record = {
    email,
    companiesToTrack: Array.isArray(companiesToTrack) ? companiesToTrack : [],
    industry,
    signals,
    otherSignal: otherSignal || "",
    createdAt:
      existingIndex >= 0 ? users[existingIndex].createdAt : new Date().toISOString(),
  };

  if (existingIndex >= 0) {
    users[existingIndex] = record;
  } else {
    users.push(record);
  }

  await writeUsers(users);
  return record;
}
