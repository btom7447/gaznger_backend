import axios from "axios";

/**
 * Paystack HTTP client. Reads the secret key at request time (not at
 * module load) so the env-switching helper below can flip between
 * test/live without a server restart in dev.
 *
 * Env vars (all optional except one of the secret pair):
 *   PAYSTACK_SECRET_KEY          — used as the default
 *   PAYSTACK_SECRET_KEY_TEST     — picked when NODE_ENV !== "production"
 *   PAYSTACK_SECRET_KEY_LIVE     — picked when NODE_ENV === "production"
 *
 * Webhook secret matches the active secret key (Paystack signs webhooks
 * with the same secret used to authenticate API calls).
 */

const PAYSTACK_BASE_URL = "https://api.paystack.co";

export function paystackSecret(): string {
  const env = process.env.NODE_ENV;
  if (env === "production" && process.env.PAYSTACK_SECRET_KEY_LIVE) {
    return process.env.PAYSTACK_SECRET_KEY_LIVE;
  }
  if (env !== "production" && process.env.PAYSTACK_SECRET_KEY_TEST) {
    return process.env.PAYSTACK_SECRET_KEY_TEST;
  }
  return process.env.PAYSTACK_SECRET_KEY ?? "";
}

function client() {
  return axios.create({
    baseURL: PAYSTACK_BASE_URL,
    headers: {
      Authorization: `Bearer ${paystackSecret()}`,
      "Content-Type": "application/json",
    },
  });
}

/** Public key (sent to mobile so the SDK can open the webview). */
export function paystackPublicKey(): string {
  const env = process.env.NODE_ENV;
  if (env === "production" && process.env.PAYSTACK_PUBLIC_KEY_LIVE) {
    return process.env.PAYSTACK_PUBLIC_KEY_LIVE;
  }
  if (env !== "production" && process.env.PAYSTACK_PUBLIC_KEY_TEST) {
    return process.env.PAYSTACK_PUBLIC_KEY_TEST;
  }
  return process.env.PAYSTACK_PUBLIC_KEY ?? "";
}

export interface PaystackAuthorization {
  authorization_code: string;
  bin?: string;
  last4: string;
  exp_month?: string;
  exp_year?: string;
  channel?: string;
  card_type?: string;
  bank?: string;
  brand?: string;
  reusable?: boolean;
  signature?: string;
  account_name?: string;
}

export async function initializePayment(params: {
  email: string;
  amount: number; // in kobo (multiply NGN by 100)
  reference: string;
  metadata?: Record<string, any>;
  channels?: ("card" | "bank_transfer" | "ussd" | "qr" | "mobile_money")[];
}) {
  const { data } = await client().post("/transaction/initialize", params);
  return data.data as {
    authorization_url: string;
    reference: string;
    access_code: string;
  };
}

export async function verifyPayment(reference: string) {
  const { data } = await client().get(`/transaction/verify/${reference}`);
  return data.data as {
    status: string;
    reference: string;
    amount: number;
    metadata: Record<string, any>;
    customer?: { email?: string };
    authorization?: PaystackAuthorization;
  };
}

/**
 * Charge a previously-saved authorization (no webview). Used for
 * returning customers after their first card has been saved via the
 * normal initialize → verify flow.
 */
export async function chargeAuthorization(params: {
  authorization_code: string;
  email: string;
  amount: number; // in kobo
  reference: string;
  metadata?: Record<string, any>;
}) {
  const { data } = await client().post("/transaction/charge_authorization", params);
  return data.data as {
    status: string;
    reference: string;
    amount: number;
    authorization?: PaystackAuthorization;
  };
}

/**
 * Reverse a successful charge in full. Paystack's refund API is async —
 * status will be "pending" or "processed" depending on the channel.
 * Webhook event `refund.processed` is the authoritative finalizer.
 */
export async function refundTransaction(params: {
  transaction: string; // reference or id
  amount?: number; // optional kobo for partial — we only do full for v1
  customer_note?: string;
  merchant_note?: string;
}) {
  const { data } = await client().post("/refund", params);
  return data.data as { status: string; transaction: { reference: string }; id: number };
}

export async function listBanks() {
  const { data } = await client().get("/bank?currency=NGN&perPage=200&use_cursor=false");
  return data.data as { id: number; name: string; code: string; longcode: string }[];
}

export async function resolveBankAccount(params: {
  account_number: string;
  bank_code: string;
}) {
  const { data } = await client().get("/bank/resolve", { params });
  return data.data as { account_number: string; account_name: string; bank_id: number };
}

export async function createTransferRecipient(params: {
  name: string;
  account_number: string;
  bank_code: string;
}) {
  const { data } = await client().post("/transferrecipient", {
    type: "nuban",
    currency: "NGN",
    ...params,
  });
  return data.data as { recipient_code: string; id: number; active: boolean };
}

export async function initiateTransfer(params: {
  amount: number; // in kobo
  recipient: string; // recipient_code
  reason?: string;
  reference?: string;
}) {
  const { data } = await client().post("/transfer", {
    source: "balance",
    ...params,
  });
  return data.data as { transfer_code: string; status: string; id: number };
}

/** Fetch the merchant's Paystack balance — used by the reconciliation cron. */
export async function fetchBalance() {
  const { data } = await client().get("/balance");
  return data.data as { currency: string; balance: number }[];
}
