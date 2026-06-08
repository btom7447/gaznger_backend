import AuditLog, { AuditAction } from "../models/AuditLog";

/**
 * Immutable record of every state-changing admin action. Helper
 * extracted from adminPayments.ts so admin.ts (and any future
 * privileged router) can call it without duplication.
 *
 * SECURITY P1 (audit run 5): admin.ts used to duplicate many privileged
 * mutators that exist in adminPayments.ts but skipped audit log writes.
 * Clients could pick whichever path bypassed audit. Single source of
 * truth here closes that drift.
 */
export async function writeAudit(args: {
  actor: string;
  action: AuditAction;
  targetKind: "User" | "Order" | "Withdrawal" | "Dispute" | "PlatformConfig" | "Earning";
  target: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  ip?: string;
}): Promise<void> {
  await AuditLog.create({
    actor: args.actor,
    action: args.action,
    targetKind: args.targetKind,
    target: args.target,
    before: args.before,
    after: args.after,
    reason: args.reason,
    ip: args.ip,
  });
}
