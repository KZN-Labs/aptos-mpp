import {
  Account,
  Ed25519PublicKey,
  Ed25519Signature,
} from "@aptos-labs/ts-sdk";
import type { SessionVoucher } from "../protocol.js";
import { createHash } from "node:crypto";

/**
 * Encode a voucher's fields into the canonical byte buffer for signing.
 *
 * Format: SHA3-256(channel_id_le64 || cumulative_amount_le64 || nonce_le64 || expiry_le64)
 * Each field is an 8-byte little-endian u64 — exactly matching the Move contract's
 * `build_voucher_message`. channelId is a decimal string (e.g. "0", "42") as returned
 * by the on-chain ChannelOpened event.
 */
export function encodeVoucherMessage(
  channelId: string,
  cumulativeAmount: bigint,
  nonce: number,
  expiry: number,
): Uint8Array {
  const channelIdBuf = Buffer.alloc(8);
  channelIdBuf.writeBigUInt64LE(BigInt(channelId));

  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(cumulativeAmount);

  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(nonce));

  const expiryBuf = Buffer.alloc(8);
  expiryBuf.writeBigUInt64LE(BigInt(expiry));

  // 32-byte preimage — 4 × 8-byte LE u64, matching the Move contract.
  const preimage = Buffer.concat([channelIdBuf, amountBuf, nonceBuf, expiryBuf]);
  return new Uint8Array(createHash("sha3-256").update(preimage).digest());
}

/**
 * Sign a payment voucher with an Aptos Ed25519 account.
 */
export async function signVoucher(
  account: Account,
  channelId: string,
  cumulativeAmount: bigint,
  nonce: number,
  expiry: number,
): Promise<SessionVoucher> {
  const message = encodeVoucherMessage(channelId, cumulativeAmount, nonce, expiry);
  const signatureHex = account.sign(message).toString();

  return {
    channelId,
    cumulativeAmount: cumulativeAmount.toString(),
    nonce,
    expiry,
    signature: signatureHex.startsWith("0x") ? signatureHex.slice(2) : signatureHex,
  };
}

/**
 * Verify a payment voucher signature.
 *
 * @returns true if the signature is valid for the given public key.
 */
export function verifyVoucher(
  voucher: SessionVoucher,
  publicKeyHex: string,
): boolean {
  try {
    const message = encodeVoucherMessage(
      voucher.channelId,
      BigInt(voucher.cumulativeAmount),
      voucher.nonce,
      voucher.expiry,
    );

    const pubKey = new Ed25519PublicKey(
      publicKeyHex.startsWith("0x") ? publicKeyHex : `0x${publicKeyHex}`,
    );
    const sig = new Ed25519Signature(
      voucher.signature.startsWith("0x")
        ? voucher.signature
        : `0x${voucher.signature}`,
    );

    return pubKey.verifySignature({ message, signature: sig });
  } catch {
    return false;
  }
}
