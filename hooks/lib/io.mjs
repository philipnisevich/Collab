// Shared hook I/O: read the hook event JSON from stdin, emit responses.
// A hook must NEVER crash or block the dev's session: catch everything, exit 0.

export async function readHookInput() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  try {
    return JSON.parse(data || "{}");
  } catch {
    return {};
  }
}

/** Emit additionalContext for the given hook event and exit cleanly. */
export function emitContext(hookEventName, additionalContext) {
  if (additionalContext) {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } })
    );
  }
  process.exit(0);
}

/** Run a hook body with a hard guarantee of exit 0. */
export async function safely(fn) {
  try {
    await fn();
  } catch {
    /* swallow — a broken hook must not break the session */
  }
  process.exit(0);
}
