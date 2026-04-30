import { z } from "zod";

// ── Sub-schemas ────────────────────────────────────────────────────────────

const aptosAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{1,64}$/, "Invalid Aptos address");

const baseUnitAmount = z
  .string()
  .regex(/^\d+$/, "Amount must be a non-negative integer string");

export const AptosPaymentSplitSchema = z.object({
  recipient: aptosAddress,
  amount: baseUnitAmount,
  description: z.string().max(256).optional(),
});

// ── Method details (inside challenge request) ──────────────────────────────

export const AptosMethodDetailsSchema = z.object({
  network: z.enum(["mainnet", "testnet", "devnet", "localnet"]),

  // Token identification. Omit assetAddress for native APT.
  assetAddress: z.string().optional(),
  tokenStandard: z.enum(["coin", "fa"]).optional(),
  decimals: z.number().int().min(0).max(18),

  // Pull-mode fields populated by the server
  sequenceNumber: z.string().optional(),
  expirationTimestampSecs: z.number().int().positive().optional(),

  // Gas sponsorship
  feePayerAddress: aptosAddress.optional(),
  feePayerPublicKey: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),

  // Accepted settlement types, in server preference order
  acceptedTypes: z
    .array(z.enum(["transaction", "hash"]))
    .min(1)
    .default(["transaction", "hash"]),

  // Payment splits (max 5 recipients)
  splits: z.array(AptosPaymentSplitSchema).max(5).optional(),
});

// ── Charge request (base64url-encoded in WWW-Authenticate) ─────────────────

export const ChargeRequestSchema = z.object({
  amount: baseUnitAmount,
  currency: z.string().min(1).max(20),
  recipient: aptosAddress,
  description: z.string().max(512).optional(),
  externalId: z.string().max(128).optional(),
  methodDetails: AptosMethodDetailsSchema,
});

// ── Credential payloads (base64url-encoded in Authorization) ───────────────

/**
 * Pull mode: client sends the raw signed transaction for the server to
 * simulate, co-sign (fee payer), and broadcast.
 *
 * The `transaction` field is a JSON-stringified object:
 *   { rawTransaction: hex, senderAuthenticator: hex }
 * where each hex string is the BCS-encoded bytes of the respective type.
 */
export const AptosTransactionPayloadSchema = z.object({
  type: z.literal("transaction"),
  transaction: z.string().min(1),
});

/**
 * Push mode: client has already broadcast the transaction on-chain and sends
 * the resulting hash. The server verifies the on-chain transfer parameters.
 */
export const AptosHashPayloadSchema = z.object({
  type: z.literal("hash"),
  hash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "Invalid transaction hash"),
});

export const AptosChargePayloadSchema = z.discriminatedUnion("type", [
  AptosTransactionPayloadSchema,
  AptosHashPayloadSchema,
]);

export const PaymentCredentialSchema = z.object({
  id: z.string().uuid(),
  method: z.literal("aptos"),
  intent: z.literal("charge"),
  payload: AptosChargePayloadSchema,
});

// ── Session schemas ────────────────────────────────────────────────────────

export const SessionRequestSchema = z.object({
  channelId: z.string().optional(),
  cumulativeAmount: baseUnitAmount.optional(),
  suggestedDeposit: baseUnitAmount.optional(),
  currency: z.string().min(1).max(20),
  recipient: aptosAddress,
  methodDetails: AptosMethodDetailsSchema,
});

export const SessionVoucherSchema = z.object({
  channelId: z.string().min(1),
  cumulativeAmount: baseUnitAmount,
  nonce: z.number().int().nonnegative(),
  expiry: z.number().int().positive(),
  signature: z.string().regex(/^[0-9a-fA-F]+$/),
});

export const SessionCredentialSchema = z.object({
  id: z.string().uuid(),
  method: z.literal("aptos"),
  intent: z.literal("session"),
  payload: SessionVoucherSchema,
});

// ── Inferred TypeScript types ──────────────────────────────────────────────

export type AptosPaymentSplit = z.infer<typeof AptosPaymentSplitSchema>;
export type AptosMethodDetails = z.infer<typeof AptosMethodDetailsSchema>;
export type ChargeRequest = z.infer<typeof ChargeRequestSchema>;
export type AptosTransactionPayload = z.infer<typeof AptosTransactionPayloadSchema>;
export type AptosHashPayload = z.infer<typeof AptosHashPayloadSchema>;
export type AptosChargePayload = z.infer<typeof AptosChargePayloadSchema>;
export type PaymentCredential = z.infer<typeof PaymentCredentialSchema>;
export type SessionRequest = z.infer<typeof SessionRequestSchema>;
export type SessionVoucher = z.infer<typeof SessionVoucherSchema>;
export type SessionCredential = z.infer<typeof SessionCredentialSchema>;
