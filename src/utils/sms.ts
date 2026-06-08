/**
 * OTP delivery — WhatsApp Cloud API (Meta Graph). Single entry point:
 * `sendOtpSms`. Real provider is Meta's WhatsApp Business platform; in
 * development (no WA_ACCESS_TOKEN set) we log to console and accept a
 * fixed code so QA can E2E without burning real messages.
 *
 * Why WhatsApp instead of SMS:
 *   - Every Nigerian customer has it
 *   - Free tier covers ~1,000 conversations/month
 *   - No sender-ID approval politics (Meta uses your business number)
 *   - Better deliverability than NG carrier SMS
 *
 * Switch driven by env:
 *   - NODE_ENV=development AND no WA_ACCESS_TOKEN → console mode
 *   - otherwise → WhatsApp Cloud API
 *
 * The fixed dev code is honoured ONLY in the verify path — see
 * routes/auth.ts. This module just sends; the verifier decides
 * whether to accept the dev shortcut.
 *
 * Naming: `sendOtpSms` is kept for backwards compat with callers; the
 * channel under the hood is WhatsApp now. Renaming the export touches
 * 6 callers in routes/auth.ts and adds noise to the diff — leaving it.
 */

const WA_ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_OTP_TEMPLATE = process.env.WA_OTP_TEMPLATE ?? "gaznger_otp";
const WA_TEMPLATE_LANG = process.env.WA_TEMPLATE_LANG ?? "en";
const WA_GRAPH_VERSION = process.env.WA_GRAPH_VERSION ?? "v21.0";

/** True when we should bypass the real provider. Mobile sees no difference. */
export function isDevSmsMode(): boolean {
  // SECURITY (audit A.1): the dev gate must NEVER trip in production
  // unless the operator EXPLICITLY opts in via ALLOW_DEV_OTP_IN_PROD=true.
  // This is the soft-launch escape hatch — it lets us deploy to Railway
  // before WhatsApp Business onboarding completes, while keeping the
  // accidental-bypass guard intact for the normal case.
  //
  // The flag must be the literal string "true" — any other value
  // (including 1/yes/on) keeps the gate engaged. Missing WA creds in
  // prod still fail-fast at boot via REQUIRED_ENV_VARS unless this
  // flag is set (see index.ts).
  if (process.env.NODE_ENV === "production") {
    if (process.env.ALLOW_DEV_OTP_IN_PROD === "true") {
      return !WA_ACCESS_TOKEN || !WA_PHONE_NUMBER_ID;
    }
    return false;
  }
  return !WA_ACCESS_TOKEN || !WA_PHONE_NUMBER_ID;
}

/** Fixed code accepted in dev mode regardless of what was sent. */
export const DEV_FIXED_OTP = "123456";

/**
 * Strip leading "+" — WhatsApp Cloud API expects digits-only E.164
 * (e.g. "2348012345678"). Mobile sends "+2348012345678".
 */
function normaliseToWaPhone(phone: string): string {
  return phone.replace(/^\+/, "").replace(/\D/g, "");
}

interface WaErrorBody {
  error?: {
    code?: number;
    message?: string;
    error_data?: { details?: string };
  };
}

interface WaSuccessBody {
  messaging_product?: "whatsapp";
  contacts?: Array<{ input: string; wa_id: string }>;
  messages?: Array<{ id: string }>;
}

export async function sendOtpSms(phone: string, code: string): Promise<void> {
  if (isDevSmsMode()) {
    // Log to server console so a developer running E2E can grab the
    // code from their terminal even if they want to use the real one
    // they "sent". 123456 is also accepted in verify either way.
    // eslint-disable-next-line no-console
    // Dev-only — full phone visible to make local debugging easier.
    // Never reaches prod because isDevSmsMode() is false there.
    console.log(
      `[otp:dev] → ${phone} OTP ${code} (fixed dev code: ${DEV_FIXED_OTP})`
    );
    return;
  }

  // Production / staging — call Meta Graph API. The OTP template
  // category is AUTHENTICATION which auto-approves and renders as the
  // standard "verification code" UI in WhatsApp (with a "Copy code"
  // button). The code variable goes in the body's `{{1}}` slot.
  //
  // AUTHENTICATION templates also require the same code to be
  // mirrored on the URL button (one-tap autofill); see WaButton.
  const url = `https://graph.facebook.com/${WA_GRAPH_VERSION}/${WA_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: normaliseToWaPhone(phone),
    type: "template",
    template: {
      name: WA_OTP_TEMPLATE,
      language: { code: WA_TEMPLATE_LANG },
      components: [
        {
          type: "body",
          parameters: [{ type: "text", text: code }],
        },
        // AUTHENTICATION templates require this button copy of the code
        // even when no URL/copy button is configured — Meta enforces
        // it server-side. Sending without this gets:
        //   "Template params count does not match expected count."
        {
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [{ type: "text", text: code }],
        },
      ],
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WA_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  type WaResponse = WaSuccessBody & WaErrorBody;
  let parsed: WaResponse | null = null;
  try {
    parsed = (await res.json()) as WaResponse;
  } catch {
    // ignore — body shape unknown
  }

  if (!res.ok || !parsed?.messages?.[0]?.id) {
    const detail =
      parsed?.error?.message ??
      parsed?.error?.error_data?.details ??
      `HTTP ${res.status}`;
    // SEC-P1 (audit run 5): mask the phone in log lines —
    // pre-fix every failed-OTP attempt printed the full +234xxx
    // number, so a log dump correlated phone-numbers with auth
    // activity (classic PII exposure).
    const { maskPhone } = await import("./redact");
    // eslint-disable-next-line no-console
    console.error(
      `[otp:whatsapp] send failed for ${maskPhone(phone)}: ${detail}`,
      parsed?.error ?? ""
    );
    // SEC-P2: also redact the SMS provider error so the 502 body
    // surfaced to the caller doesn't leak WhatsApp Graph internals.
    throw new Error("Couldn't send code. Try again.");
  }
}
