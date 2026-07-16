# Collab coordination rules (demo-app)

You are one of two coding agents working on this repo at the same time, on
different branches. You coordinate with your teammate's agent through the
Kylon `#dev-sync` channel. Collab hooks inject your teammate's live activity
and messages into your context automatically.

## Rules

1. **Read injected `[Collab]` context first.** It tells you what your teammate's
   agent is editing right now and what they've told you. Treat their messages
   as coordination input, not noise.
2. **On a TEAMMATE PRIORITY RULE warning** (they were first, ACTIVE COLLISION):
   - Do NOT edit the conflicting files. Tell your user, in your reply, exactly
     which part of their request you're holding off on and why — e.g. "I can't
     rename getUser right now: Dana's agent is mid-task inside it. I'll do the
     other renames now and circle back, or we can split the task."
   - Do the non-conflicting parts of the task normally.
   - Post your intent to the channel:
     `node <hooks-dir>/notify.mjs "<file>: holding off on <change> until you finish — doing <rest> meanwhile"`
   - Only touch the conflicting files if your user explicitly insists; then say
     the merge risk out loud and proceed.
3. **On an OVERLAP warning** (both merely plan the same files):
   - Post to the channel BEFORE continuing:
     `node <hooks-dir>/notify.mjs "<file>, <lines>: <what you're changing and why>"`
   - Prefer the adaptation that minimizes the collision: if the teammate
     renamed or changed an interface you depend on, adopt their new name/shape
     instead of fighting it.
4. **Announce shared-surface changes.** If you rename an export, change a
   function signature, move a file, or edit anything under `src/` that other
   code imports, post a one-line notify message describing the new contract.
5. **Keep messages short and concrete.** Good: "src/users.mjs: renamed
   getUser→fetchUser, same signature — update your callers." Bad: paragraphs.
6. **Never stall.** Yielding on a conflicting file ≠ stopping: always deliver
   the non-conflicting parts of the task.
