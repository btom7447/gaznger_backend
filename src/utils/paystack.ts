import axios from "axios";

const PAYSTACK_BASE_URL = "https://api.paystack.co";

const paystackClient = axios.create({
  baseURL: PAYSTACK_BASE_URL,
  headers: {
    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json",
  },
});

export async function initializePayment(params: {
  email: string;
  amount: number; // in kobo (multiply NGN by 100)
  reference: string;
  metadata?: Record<string, any>;
}) {
  const { data } = await paystackClient.post("/transaction/initialize", params);
  return data.data as {
    authorization_url: string;
    reference: string;
    access_code: string;
  };
}

export async function verifyPayment(reference: string) {
  const { data } = await paystackClient.get(`/transaction/verify/${reference}`);
  return data.data as {
    status: string;
    reference: string;
    amount: number;
    metadata: Record<string, any>;
  };
}

export async function listBanks() {
  const { data } = await paystackClient.get("/bank?currency=NGN&perPage=200&use_cursor=false");
  return data.data as { id: number; name: string; code: string; longcode: string }[];
}

export async function resolveBankAccount(params: {
  account_number: string;
  bank_code: string;
}) {
  const { data } = await paystackClient.get("/bank/resolve", { params });
  return data.data as { account_number: string; account_name: string; bank_id: number };
}

export async function createTransferRecipient(params: {
  name: string;
  account_number: string;
  bank_code: string;
}) {
  const { data } = await paystackClient.post("/transferrecipient", {
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
  const { data } = await paystackClient.post("/transfer", {
    source: "balance",
    ...params,
  });
  return data.data as { transfer_code: string; status: string; id: number };
}
