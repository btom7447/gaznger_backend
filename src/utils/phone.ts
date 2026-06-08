/**
 * Phone-number normalization shared across vendor and rider invite
 * paths so a phone stored as "2348012345678" (no +) matches one stored
 * as "+2348012345678" (with +). The two paths previously had inline
 * copies of the same logic — keeping them in lockstep here removes the
 * drift risk highlighted in the v7 rider audit.
 */

/**
 * Return the phone in `+E.164`-ish form, or null when there's nothing
 * to normalize. Strips whitespace; prefixes a `+` if missing. Doesn't
 * validate length or country code — both callers handle their own
 * regex up-front.
 */
export function normalizePhone(raw?: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\s+/g, "");
  if (!cleaned) return null;
  return cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
}
