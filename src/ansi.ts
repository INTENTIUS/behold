/**
 * ANSI stripping, pure. chant colours its output whenever `!NO_COLOR &&
 * process.stdout.isTTY !== false` — a piped stream's `isTTY` is `undefined`,
 * not `false` — and choudoufu colours its stderr the same way, so every
 * captured stream may carry raw control bytes. Split out of src/chant.ts so a
 * module that must not import chant.ts at runtime (src/choudoufu-member.ts;
 * see src/member-kind.ts's header for the cycle) can strip them too.
 * src/chant.ts re-exports it, so its callers are unchanged.
 */
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Strip ANSI colour escapes from a captured stream. Exported for testing. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}
