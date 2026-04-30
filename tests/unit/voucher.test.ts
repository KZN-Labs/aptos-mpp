import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { Account } from "@aptos-labs/ts-sdk";
import {
  signVoucher,
  verifyVoucher,
  encodeVoucherMessage,
} from "../../src/session/voucher.js";
import { RegularBudgetAuthorizer } from "../../src/session/authorizers/RegularBudget.js";
import { UnboundedAuthorizer } from "../../src/session/authorizers/Unbounded.js";

function makeAccount(): Account {
  return Account.generate();
}

// channelId is always a u64 decimal string — the value returned by the
// ChannelOpened on-chain event (e.g. "0", "42", "18446744073709551615").

describe("encodeVoucherMessage", () => {
  it("produces a 32-byte SHA3-256 digest", () => {
    const msg = encodeVoucherMessage("0", 1000n, 1, 9999999999);
    expect(msg).toBeInstanceOf(Uint8Array);
    expect(msg.length).toBe(32);
  });

  it("produces different digests for different nonces", () => {
    const channelId = "42";
    const m1 = encodeVoucherMessage(channelId, 1000n, 1, 9999999999);
    const m2 = encodeVoucherMessage(channelId, 1000n, 2, 9999999999);
    expect(Buffer.from(m1).toString("hex")).not.toBe(Buffer.from(m2).toString("hex"));
  });

  it("produces different digests for different cumulative amounts", () => {
    const channelId = "7";
    const m1 = encodeVoucherMessage(channelId, 1000n, 1, 9999999999);
    const m2 = encodeVoucherMessage(channelId, 2000n, 1, 9999999999);
    expect(Buffer.from(m1).toString("hex")).not.toBe(Buffer.from(m2).toString("hex"));
  });

  it("produces different digests for different channel IDs", () => {
    const m1 = encodeVoucherMessage("0", 1000n, 1, 9999999999);
    const m2 = encodeVoucherMessage("1", 1000n, 1, 9999999999);
    expect(Buffer.from(m1).toString("hex")).not.toBe(Buffer.from(m2).toString("hex"));
  });

  it("accepts the u64 maximum value without overflow", () => {
    const u64Max = "18446744073709551615";
    expect(() => encodeVoucherMessage(u64Max, 1000n, 1, 9999999999)).not.toThrow();
    const msg = encodeVoucherMessage(u64Max, 1000n, 1, 9999999999);
    expect(msg.length).toBe(32);
  });

  it("preimage matches the Move contract layout: 4 × 8-byte LE u64 → SHA3-256", () => {
    // channel_id=1, cumulative=500, nonce=3, expiry=1000
    // Manually build the expected preimage the same way the Move contract does.
    const preimage = Buffer.alloc(32);
    preimage.writeBigUInt64LE(1n,    0);
    preimage.writeBigUInt64LE(500n,  8);
    preimage.writeBigUInt64LE(3n,   16);
    preimage.writeBigUInt64LE(1000n, 24);
    const hash = createHash("sha3-256").update(preimage).digest();
    const actual = encodeVoucherMessage("1", 500n, 3, 1000);
    expect(Buffer.from(actual).toString("hex")).toBe(hash.toString("hex"));
  });
});

describe("signVoucher / verifyVoucher", () => {
  it("round-trips: sign then verify", async () => {
    const account = makeAccount();
    const channelId = "0";
    const cumulative = 50_000n;
    const nonce = 1;
    const expiry = Math.floor(Date.now() / 1000) + 3600;

    const voucher = await signVoucher(account, channelId, cumulative, nonce, expiry);

    expect(voucher.channelId).toBe(channelId);
    expect(voucher.cumulativeAmount).toBe("50000");
    expect(voucher.nonce).toBe(1);

    const pubKeyHex = account.publicKey.toString().replace("0x", "");
    const valid = verifyVoucher(voucher, pubKeyHex);
    expect(valid).toBe(true);
  });

  it("rejects a tampered cumulative amount", async () => {
    const account = makeAccount();
    const voucher = await signVoucher(account, "5", 1000n, 1, Date.now() + 3600);

    const tampered = { ...voucher, cumulativeAmount: "9999999" };
    const pubKeyHex = account.publicKey.toString().replace("0x", "");
    expect(verifyVoucher(tampered, pubKeyHex)).toBe(false);
  });

  it("rejects a signature from a different key", async () => {
    const signer = makeAccount();
    const other  = makeAccount();
    const voucher = await signVoucher(signer, "99", 1000n, 1, Date.now() + 3600);

    const otherPubKey = other.publicKey.toString().replace("0x", "");
    expect(verifyVoucher(voucher, otherPubKey)).toBe(false);
  });

  it("rejects a tampered channel ID", async () => {
    const account = makeAccount();
    const voucher = await signVoucher(account, "10", 1000n, 1, Date.now() + 3600);

    const tampered = { ...voucher, channelId: "11" };
    const pubKeyHex = account.publicKey.toString().replace("0x", "");
    expect(verifyVoucher(tampered, pubKeyHex)).toBe(false);
  });
});

// ── Authorizers ───────────────────────────────────────────────────────────

describe("UnboundedAuthorizer", () => {
  it("signs every request regardless of amount", async () => {
    const account = makeAccount();
    const auth = new UnboundedAuthorizer(account);

    const result = await auth.authorize({
      channelId: "0",
      currentCumulative: 0n,
      requestedAmount: 999_999_999n,
      nonce: 1,
      expiry: Math.floor(Date.now() / 1000) + 60,
    });

    expect(result.cumulativeAmount).toBe(999_999_999n);
    expect(result.signature).toBeTruthy();
  });

  it("accumulates cumulative amount across calls", async () => {
    const account = makeAccount();
    const auth = new UnboundedAuthorizer(account);

    const r1 = await auth.authorize({
      channelId: "3",
      currentCumulative: 0n,
      requestedAmount: 100n,
      nonce: 1,
      expiry: Math.floor(Date.now() / 1000) + 60,
    });
    const r2 = await auth.authorize({
      channelId: "3",
      currentCumulative: r1.cumulativeAmount,
      requestedAmount: 200n,
      nonce: 2,
      expiry: Math.floor(Date.now() / 1000) + 60,
    });

    expect(r2.cumulativeAmount).toBe(300n);
  });
});

describe("RegularBudgetAuthorizer", () => {
  it("approves requests within budget", async () => {
    const account = makeAccount();
    const auth = new RegularBudgetAuthorizer({
      signer: account,
      budgetPerPeriod: 100_000n,
      periodSeconds: 3600,
    });

    const result = await auth.authorize({
      channelId: "1",
      currentCumulative: 0n,
      requestedAmount: 50_000n,
      nonce: 1,
      expiry: Math.floor(Date.now() / 1000) + 60,
    });

    expect(result.cumulativeAmount).toBe(50_000n);
  });

  it("rejects requests that exceed the budget", async () => {
    const account = makeAccount();
    const auth = new RegularBudgetAuthorizer({
      signer: account,
      budgetPerPeriod: 100n,
      periodSeconds: 3600,
    });

    // Spend 60 first
    await auth.authorize({
      channelId: "2",
      currentCumulative: 0n,
      requestedAmount: 60n,
      nonce: 1,
      expiry: Math.floor(Date.now() / 1000) + 60,
    });

    // Second request of 50 exceeds remaining 40
    await expect(
      auth.authorize({
        channelId: "2",
        currentCumulative: 60n,
        requestedAmount: 50n,
        nonce: 2,
        expiry: Math.floor(Date.now() / 1000) + 60,
      }),
    ).rejects.toThrow("Budget exhausted");
  });
});
