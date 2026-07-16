// User service — the demo collision target. Dev A will rename getUser →
// fetchUser everywhere; Dev B will simultaneously add caching to getUser.
import { db } from "./db.mjs";

const _userCache = new Map();
export function fetchUser(id) {
  if (_userCache.has(id)) return _userCache.get(id);
  const user = db.users.get(id) ?? null;
  _userCache.set(id, user);
  return user;
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
