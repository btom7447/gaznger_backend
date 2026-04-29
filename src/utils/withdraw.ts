import mongoose from "mongoose";
import { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import User from "../models/User";
import Withdrawal from "../models/Withdrawal";
import RiderProfile from "../models/RiderProfile";
import { createTransferRecipient, initiateTransfer } from "./paystack";
import {
  getOrCreateUserWallet,
  getOrCreateSystemWallet,
  postTransfer,
} from "./wallet";
import { getPlatformConfig } from "./platformConfig";
import { emitToUser } from "../socket";

/**
 * Shared withdrawal handler for vendors + riders.
 *
 * Money flow:
 *   1. Validate gates (kill switch, hold, KYC, account status, bank set).
 *   2. Validate balance against `Wallet.available` (Wallet is now the
 *      source of truth — Earning aggregates were the old way).
 *   3. Pessimistically debit `Wallet.available` and post the ledger
 *      legs, BEFORE calling Paystack. If Paystack fails, we credit
 *      back via a reversal Transaction. This avoids the historical
 *      "fall through to manual review with no balance change" bug.
 *   4. Net the platform withdrawal fee — debit it from the user's
 *      wallet to platform-revenue.available.
 *   5. Call Paystack /transferrecipient + /transfer. Track the codes
 *      on the Withdrawal doc.
 *
 * Status:
 *   - "processing" = Paystack transfer initiated successfully (waiting
 *     on transfer.success webhook to mark "approved").
 *   - "pending"    = Paystack call failed; admin will manually transfer.
 *   - "failed"     = transfer.failed webhook reached us; balance reversed.
 */
export async function handleWithdrawRequest(
  req: Request,
  res: Response,
  role: "vendor" | "rider"
): Promise<Response> {
  try {
    const cfg = await getPlatformConfig();
    if (!cfg.withdrawalsEnabled) {
      return res
        .status(503)
        .json({ message: "Withdrawals are temporarily disabled" });
    }

    const amountNum = Number(req.body?.amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return res.status(400).json({ message: "Invalid withdrawal amount" });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    // Gate: account status
    if (user.accountStatus === "suspended") {
      return res
        .status(403)
        .json({ message: "Account suspended. Contact support." });
    }
    // Gate: withdrawal hold
    if (user.withdrawalHold?.active) {
      return res.status(403).json({
        message: user.withdrawalHold.reason
          ? `Withdrawals are on hold: ${user.withdrawalHold.reason}`
          : "Withdrawals are on hold for your account.",
      });
    }

    // Gate: bank account + KYC
    let bankAccount: any;
    if (role === "vendor") {
      if (!user.vendorBankAccount?.accountNumber) {
        return res
          .status(400)
          .json({ message: "Add a bank account before requesting a payout" });
      }
      if (user.vendorVerification?.status !== "verified") {
        return res.status(403).json({
          message: "Vendor verification required before withdrawals",
        });
      }
      bankAccount = user.vendorBankAccount;
    } else {
      const profile = await RiderProfile.findOne({ user: req.userId }).lean();
      if (!profile?.bankAccount?.accountNumber) {
        return res
          .status(400)
          .json({ message: "Add a bank account before requesting a payout" });
      }
      if (profile.verificationStatus !== "verified") {
        return res
          .status(403)
          .json({ message: "Rider verification required before withdrawals" });
      }
      bankAccount = profile.bankAccount;
    }

    // Gate: balance from wallet (not Earning aggregate)
    const wallet = await getOrCreateUserWallet(req.userId!);
    const fee = cfg.withdrawalFeeNgn;
    const totalDebit = amountNum + fee;

    if (wallet.available < totalDebit) {
      return res.status(400).json({
        message: `Insufficient balance. Available: ₦${wallet.available.toLocaleString()} (request includes ₦${fee.toLocaleString()} fee)`,
        available: wallet.available,
        requested: amountNum,
        fee,
      });
    }

    // Create the Withdrawal doc up front so we can reference its _id
    // in Transaction rows.
    const withdrawal = await Withdrawal.create({
      user: req.userId,
      role,
      amount: amountNum,
      status: "pending", // flipped to "processing" below if Paystack accepts
      bankAccount,
    });

    const platformRevenue = await getOrCreateSystemWallet("platform-revenue");

    // Debit the user's wallet — fee + payout. Two separate Transaction
    // pairs so the fee is a distinct ledger entry.
    if (fee > 0) {
      await postTransfer({
        from: wallet,
        to: platformRevenue,
        amount: fee,
        state: "available",
        kinds: ["withdraw_fee_debit", "platform_commission_credit"],
        description: `Withdrawal fee for ${withdrawal._id}`,
        opts: {
          idempotencyKey: `withdrawal:${withdrawal._id}:fee`,
          withdrawal: withdrawal._id as any,
        },
      });
    }

    // The payout debit lands in a virtual "out the door" sink — we use
    // platform-revenue as the temporary destination because it nets out
    // when Paystack reports success (the actual money has already left
    // Paystack's balance via the transfer). This row is later marked as
    // settled via `meta.settledByPaystack=true` from the webhook.
    await postTransfer({
      from: wallet,
      to: platformRevenue,
      amount: amountNum,
      state: "available",
      kinds: ["withdraw_debit", "platform_commission_credit"],
      description: `Withdrawal payout to bank ${bankAccount.accountNumber}`,
      opts: {
        idempotencyKey: `withdrawal:${withdrawal._id}:payout`,
        withdrawal: withdrawal._id as any,
        meta: { fee, totalDebit, bank: bankAccount.bankName },
      },
    });

    // Now attempt Paystack. If it fails, restore the wallet via a
    // reversal Transaction.
    let paystackTransferCode: string | undefined;
    let paystackRecipientCode: string | undefined;
    let withdrawalStatus: "pending" | "processing" = "pending";

    if (bankAccount?.bankCode) {
      try {
        const recipient = await createTransferRecipient({
          name: bankAccount.accountName,
          account_number: bankAccount.accountNumber,
          bank_code: bankAccount.bankCode,
        });
        paystackRecipientCode = recipient.recipient_code;

        const transfer = await initiateTransfer({
          amount: amountNum * 100,
          recipient: recipient.recipient_code,
          reason: `Gaznger ${role} payout`,
          reference: `${role}-${withdrawal._id.toString().slice(-12)}-${Date.now().toString(36)}`,
        });
        paystackTransferCode = transfer.transfer_code;
        withdrawalStatus = "processing";
      } catch (paystackErr) {
        // Reverse the debits — money is still on platform.
        await postTransfer({
          from: platformRevenue,
          to: wallet,
          amount: amountNum,
          state: "available",
          kinds: ["platform_commission_credit", "withdraw_reversal_credit"],
          description: `Reverse failed withdrawal ${withdrawal._id}`,
          opts: {
            idempotencyKey: `withdrawal:${withdrawal._id}:reverse`,
            withdrawal: withdrawal._id as any,
          },
        });
        if (fee > 0) {
          await postTransfer({
            from: platformRevenue,
            to: wallet,
            amount: fee,
            state: "available",
            kinds: ["platform_commission_credit", "withdraw_reversal_credit"],
            description: `Reverse fee for failed withdrawal ${withdrawal._id}`,
            opts: {
              idempotencyKey: `withdrawal:${withdrawal._id}:reverse-fee`,
              withdrawal: withdrawal._id as any,
            },
          });
        }
        // Surface to caller as failed; admin can retry.
        await Withdrawal.updateOne(
          { _id: withdrawal._id },
          { status: "failed", note: "Paystack transfer init failed; balance reversed." }
        );
        const fresh = await getOrCreateUserWallet(req.userId!);
        emitToUser(req.userId!, "wallet:update", {
          available: fresh.available,
          pending: fresh.pending,
        });
        return res.status(502).json({
          message:
            "Paystack rejected the transfer. Your balance has been restored. Please try again.",
        });
      }
    }
    // (No bankCode → skip Paystack, leave as "pending" for admin manual.)

    await Withdrawal.updateOne(
      { _id: withdrawal._id },
      {
        status: withdrawalStatus,
        paystackTransferCode,
        paystackRecipientCode,
      }
    );

    const fresh = await getOrCreateUserWallet(req.userId!);
    emitToUser(req.userId!, "wallet:update", {
      available: fresh.available,
      pending: fresh.pending,
    });

    const message =
      withdrawalStatus === "processing"
        ? "Payout initiated via Paystack. Funds will arrive within minutes."
        : "Payout request submitted. We'll process it within 1–3 business days.";

    return res.status(201).json({
      message,
      withdrawal: {
        ...withdrawal.toObject(),
        status: withdrawalStatus,
        paystackTransferCode,
        paystackRecipientCode,
      },
      status: withdrawalStatus,
      fee,
      net: amountNum,
    });
  } catch (err) {
    console.error(`[withdraw:${role}]`, err);
    return res.status(500).json({ message: "Failed to request payout" });
  }
}
