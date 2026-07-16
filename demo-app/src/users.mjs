// User service — the demo collision target. Dev A will rename getUser →
// fetchUser everywhere; Dev B will simultaneously add caching to getUser.
import { db } from "./db.mjs";

export function getUser(id) {
  return db.users.get(id) ?? null;
}

export function listUsers() {
  return [...db.users.values()];
}

export function createUser({ name, email }) {
  const id = String(db.users.size + 1);
  const user = { id, name, email };
  db.users.set(id, user);
  return user;
}
