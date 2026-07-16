import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff, rangesOverlap, detectOverlap, formatFindings } from "../hooks/lib/overlap.mjs";

const DIFF = `diff --git a/src/users.js b/src/users.js
index 1111111..2222222 100644
--- a/src/users.js
+++ b/src/users.js
@@ -10,0 +11,3 @@ function listUsers() {
+function getUser(id) {
+  return db.users.get(id);
+}
@@ -40,2 +44,2 @@ function createUser(u) {
-  db.users.set(u.id, u);
-  return u;
+  db.users.set(u.id, normalize(u));
+  return normalize(u);
diff --git a/src/db.js b/src/db.js
index 3333333..4444444 100644
--- a/src/db.js
+++ b/src/db.js
@@ -5 +5,0 @@ const db = {
-  legacy: true,
`;

test("parseUnifiedDiff extracts per-file new-side hunk ranges", () => {
  const parsed = parseUnifiedDiff(DIFF);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].file, "src/users.js");
  assert.deepEqual(parsed[0].hunks, [
    { start: 11, end: 13 },
    { start: 44, end: 45 },
  ]);
  // pure deletion (+5,0) keeps a 1-line marker at the anchor
  assert.equal(parsed[1].file, "src/db.js");
  assert.deepEqual(parsed[1].hunks, [{ start: 5, end: 5 }]);
});

test("parseUnifiedDiff handles empty and garbage input", () => {
  assert.deepEqual(parseUnifiedDiff(""), []);
  assert.deepEqual(parseUnifiedDiff("not a diff at all\n@@ malformed @@"), []);
});

test("rangesOverlap basic + fuzz", () => {
  assert.ok(rangesOverlap({ start: 10, end: 20 }, { start: 15, end: 25 }));
  assert.ok(!rangesOverlap({ start: 10, end: 20 }, { start: 22, end: 30 }));
  assert.ok(rangesOverlap({ start: 10, end: 20 }, { start: 22, end: 30 }, 5)); // adjacent within fuzz
  assert.ok(rangesOverlap({ start: 22, end: 30 }, { start: 10, end: 20 }, 5)); // symmetric
});

test("detectOverlap flags high on hunk collision, medium on same-file", () => {
  const mine = parseUnifiedDiff(DIFF);
  const theirs = [
    { dev: "sam", branch: "feat-cache", file: "src/users.js", start: 12, end: 18, ts: Date.now() },
    { dev: "sam", branch: "feat-cache", file: "src/routes.js", start: 1, end: 9, ts: Date.now() },
  ];
  const findings = detectOverlap(mine, theirs, { fuzz: 10 });
  const high = findings.filter((f) => f.severity === "high");
  // hunk 11-13 collides with sam's 12-18; hunk 44-45 is beyond fuzz of 18+10
  assert.equal(high.length, 1);
  assert.equal(high[0].mine.start, 11);
  // no medium duplicate for users.js since a high already fired
  assert.ok(!findings.some((f) => f.severity === "medium" && f.file === "src/users.js"));
});

test("detectOverlap: same file, disjoint regions beyond fuzz → medium", () => {
  const mine = [{ file: "src/users.js", hunks: [{ start: 100, end: 105 }] }];
  const theirs = [{ dev: "sam", branch: "b", file: "src/users.js", start: 1, end: 5, ts: Date.now() }];
  const findings = detectOverlap(mine, theirs, { fuzz: 10 });
  assert.deepEqual(findings.map((f) => f.severity), ["medium"]);
});

test("detectOverlap: different files → no findings", () => {
  const mine = [{ file: "a.js", hunks: [{ start: 1, end: 10 }] }];
  const theirs = [{ dev: "sam", branch: "b", file: "b.js", start: 1, end: 10, ts: Date.now() }];
  assert.deepEqual(detectOverlap(mine, theirs), []);
});

test("formatFindings renders a compact warning", () => {
  const text = formatFindings([
    {
      file: "src/users.js",
      severity: "high",
      mine: { start: 11, end: 13 },
      theirs: { dev: "sam", branch: "feat-cache", start: 12, end: 18 },
    },
  ]);
  assert.match(text, /CONFLICT RISK/);
  assert.match(text, /HIGH src\/users\.js/);
  assert.match(text, /sam \(feat-cache\)/);
});
