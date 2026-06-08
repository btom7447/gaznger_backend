/**
 * SEC-P1 (audit run 5): regex-injection + ReDoS defence.
 *
 * Mongo's `$regex` operator accepts arbitrary user input. Without
 * sanitization, `?search=(.*a){25}` triggers catastrophic backtracking
 * across the entire collection — a hostile/compromised admin pins
 * mongod CPU on a single page load. The same shape applies to public
 * endpoints that take a search string (signup product filter, station
 * search).
 *
 * `safeRegexSearch` produces a Mongo $regex pattern that is:
 *   1. Length-capped (default 64 chars) so an attacker can't submit
 *      a 10KB regex.
 *   2. Escaped — every special character becomes a literal.
 *   3. Optionally anchored with `^` for prefix-match semantics
 *      (faster + no surprise interior matches).
 *
 * Case-insensitivity is left to Mongo's `$options: "i"` flag —
 * cheaper than `(?i)` and not part of the user-controlled input.
 */
export function safeRegexSearch(
  raw: unknown,
  opts: { maxLen?: number; prefix?: boolean } = {},
): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const maxLen = opts.maxLen ?? 64;
  const trimmed = raw.trim().slice(0, maxLen);
  if (!trimmed) return null;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return opts.prefix ? `^${escaped}` : escaped;
}
