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
