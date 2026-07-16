import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractTokens, matchExplicit, predictFileSet } from "../hooks/lib/predict.mjs";
import { detectPromptConflicts, formatPromptConflicts, rowKind } from "../hooks/lib/overlap.mjs";

test("extractTokens keeps code-ish identifiers, drops prose", () => {
  const tokens = extractTokens("Rename getUser to fetchUser across the codebase please");
  assert.ok(tokens.includes("getUser"));
  assert.ok(tokens.includes("fetchUser"));
  assert.ok(!tokens.includes("across"));
  assert.ok(!tokens.includes("please"));
});

test("extractTokens falls back to plain words when nothing code-ish", () => {
  const tokens = extractTokens("improve the login validation");
  assert.ok(tokens.includes("login") || tokens.includes("validation"));
});

test("matchExplicit matches full paths and basenames", () => {
  const files = ["src/users.mjs", "src/db.mjs", "README.md"];
  assert.deepEqual(matchExplicit("edit src/users.mjs", files), ["src/users.mjs"]);
  assert.deepEqual(matchExplicit("look at users.mjs for this", files), ["src/users.mjs"]);
  assert.deepEqual(matchExplicit("nothing relevant here", files), []);
});

test("predictFileSet: explicit + structural against a real repo", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-predict-"));
  const run = (args) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/users.mjs"), "export function getUser(id) { return id; }\n");
  fs.writeFileSync(path.join(dir, "src/server.mjs"), 'import { getUser } from "./users.mjs";\n');
  fs.writeFileSync(path.join(dir, "src/db.mjs"), "export const db = {};\n");
  run(["init", "-q", "-b", "main"]);
  run(["add", "-A"]);
  run(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);

  const predicted = predictFileSet(dir, "Rename getUser to fetchUser across the codebase");
  const byFile = Object.fromEntries(predicted.map((p) => [p.file, p.source]));
  // getUser is defined in users.mjs and imported in server.mjs → structural hits
  assert.ok(byFile["src/users.mjs"]);
  assert.ok(byFile["src/server.mjs"]);
  assert.ok(!byFile["src/db.mjs"]); // untouched by the symbol

  const explicit = predictFileSet(dir, "clean up src/db.mjs");
  assert.equal(explicit.find((p) => p.file === "src/db.mjs")?.source, "explicit");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("detectPromptConflicts tiers: active-collision beats overlap", () => {
  const predicted = [
    { file: "src/users.mjs", source: "structural" },
    { file: "src/api.mjs", source: "explicit" },
    { file: "src/free.mjs", source: "explicit" },
  ];
  const theirs = [
    { dev: "sam", branch: "b", file: "src/users.mjs", kind: "active", start: 5, end: 9, ts: Date.now() },
    { dev: "sam", branch: "b", file: "src/api.mjs", kind: "predicted", ts: Date.now() },
  ];
  const findings = detectPromptConflicts(predicted, theirs);
  assert.deepEqual(
    findings.map((f) => [f.tier, f.file]),
    [
      ["active-collision", "src/users.mjs"],
      ["overlap", "src/api.mjs"],
    ]
  );
  const text = formatPromptConflicts(findings);
  assert.match(text, /ACTIVE COLLISION src\/users\.mjs/);
  assert.match(text, /OVERLAP src\/api\.mjs/);
  // active collision present → teammate priority rule, not the soft options
  assert.match(text, /TEAMMATE PRIORITY RULE/);
  assert.match(text, /Do NOT make changes/);

  // overlap-only findings keep the soft coordinate options
  const soft = formatPromptConflicts(findings.filter((f) => f.tier === "overlap"));
  assert.match(soft, /\(b\) split the task/);
  assert.ok(!/TEAMMATE PRIORITY RULE/.test(soft));
});

test("rowKind infers kind for legacy rows", () => {
  assert.equal(rowKind({ file: null }), "presence");
  assert.equal(rowKind({ file: "a.js", start: 1, end: 2 }), "active");
  assert.equal(rowKind({ file: "a.js" }), "predicted");
  assert.equal(rowKind({ file: "a.js", kind: "active" }), "active");
});
