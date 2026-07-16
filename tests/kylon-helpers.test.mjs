import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSentMessageId,
  renderBoard,
  matchThreadFile,
  shouldEscalate,
} from "../hooks/lib/kylon.mjs";

test("parseSentMessageId extracts the id from verified CLI output", () => {
  assert.equal(parseSentMessageId("Sent message (id: 351be3989e7b)"), "351be3989e7b");
  assert.equal(parseSentMessageId("Sent message (id: 351be3989e7b)\n"), "351be3989e7b");
  assert.equal(parseSentMessageId("Error: 404"), null);
  assert.equal(parseSentMessageId(null), null);
});

test("renderBoard: one line per file, statuses, sorted, deterministic", () => {
  const now = 1_000_000;
  const state = {
    dev: "dev-a",
    branch: "feat-a",
    status: "editing",
    predicted: [{ file: "src/server.mjs" }, { file: "src/users.mjs" }],
    active: [
      { file: "src/users.mjs", start: 10, end: 25, ts: now },
      { file: "src/users.mjs", start: 40, end: 44, ts: now },
      { file: "src/db.mjs", start: 3, end: 9, ts: now },
    ],
  };
  const text = renderBoard(state, { "src/users.mjs": now - 1000 }, now);
  const lines = text.split("\n");
  assert.match(lines[0], /^\[collab-board:dev-a\] 📋 Activity Board — dev-a on `feat-a` \(editing\)$/);
  // sorted: db, server, users — active file with conflict mark shows CONFLICT + merged ranges
  assert.equal(lines[1], "✏️ src/db.mjs — editing (lines 3-9)");
  assert.equal(lines[2], "📝 src/server.mjs — planning");
  assert.equal(lines[3], "🔴 src/users.mjs — CONFLICT (lines 10-25, 40-44)");
  // identical inputs render identical text (the no-change throttle relies on this)
  assert.equal(renderBoard(state, { "src/users.mjs": now - 1000 }, now), text);
});

test("renderBoard: expired conflict marks fall back to editing; empty board", () => {
  const now = 1_000_000;
  const state = { dev: "d", branch: "main", status: "editing", predicted: [], active: [{ file: "a.js", start: 1, end: 2, ts: now }] };
  const stale = renderBoard(state, { "a.js": now - 11 * 60_000 }, now);
  assert.match(stale, /✏️ a\.js — editing/);
  assert.match(renderBoard({ dev: "d", branch: "main", status: "idle" }, {}, now), /\(no files in flight\)/);
});

test("matchThreadFile: fresh threads match by path or basename, longest path wins", () => {
  const now = 1_000_000;
  const map = {
    "src/users.mjs": { root: "aaa", ts: now - 1000 },
    "src/db.mjs": { root: "bbb", ts: now - 1000 },
    "src/old.mjs": { root: "ccc", ts: now - 60 * 60_000 }, // expired
  };
  assert.deepEqual(matchThreadFile(map, "changed src/users.mjs lines 10-25", now), { file: "src/users.mjs", root: "aaa" });
  assert.deepEqual(matchThreadFile(map, "refactoring db.mjs now", now), { file: "src/db.mjs", root: "bbb" });
  assert.equal(matchThreadFile(map, "touching src/old.mjs", now), null);
  assert.equal(matchThreadFile(map, "nothing relevant", now), null);
  assert.equal(matchThreadFile({}, "src/users.mjs", now), null);
});

test("shouldEscalate: >=2 events in window, at most once per window", () => {
  const now = 1_000_000_000;
  const w = 10 * 60_000;
  assert.equal(shouldEscalate([now], now), false); // single event
  assert.equal(shouldEscalate([now - w - 1, now], now), false); // first event aged out
  assert.equal(shouldEscalate([now - 60_000, now], now), true); // two fresh events
  assert.equal(shouldEscalate([now - 60_000, now], now, { lastEscalatedAt: now - 5 * 60_000 }), false); // throttled
  assert.equal(shouldEscalate([now - 60_000, now], now, { lastEscalatedAt: now - w - 1 }), true); // throttle expired
});
