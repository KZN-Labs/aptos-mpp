import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryStore } from "../../src/server/Store.js";
import { InMemoryChannelStore } from "../../src/session/ChannelStore.js";
import type { ChannelState } from "../../src/session/types.js";

// ── InMemoryChannelStore ───────────────────────────────────────────────────

describe("InMemoryChannelStore", () => {
  let store: InMemoryChannelStore;

  const sample: ChannelState = {
    channelId: "0",
    clientAddress: "0xclient",
    // 64-char hex = 32-byte Ed25519 public key (test placeholder)
    clientPublicKey: "a".repeat(64),
    recipientAddress: "0xrecipient",
    assetAddress: undefined,
    tokenStandard: "coin",
    depositedAmount: 10_000_000n,
    cumulativePaid: 0n,
    lastNonce: 0,
    expiryTimestamp: Math.floor(Date.now() / 1000) + 3600,
    openTxHash: "0x" + "aa".repeat(32),
    network: "testnet",
  };

  beforeEach(() => {
    store = new InMemoryChannelStore();
  });

  it("saves and retrieves a channel", async () => {
    await store.save(sample);
    const fetched = await store.get(sample.channelId);
    expect(fetched?.channelId).toBe(sample.channelId);
    expect(fetched?.depositedAmount).toBe(10_000_000n);
  });

  it("returns undefined for unknown channelId", async () => {
    const ch = await store.get("9999");
    expect(ch).toBeUndefined();
  });

  it("updates fields", async () => {
    await store.save(sample);
    await store.update(sample.channelId, { cumulativePaid: 5_000n, lastNonce: 3 });
    const updated = await store.get(sample.channelId);
    expect(updated?.cumulativePaid).toBe(5_000n);
    expect(updated?.lastNonce).toBe(3);
  });

  it("throws on update of unknown channel", async () => {
    await expect(
      store.update("8888", { lastNonce: 1 }),
    ).rejects.toThrow();
  });

  it("deletes a channel", async () => {
    await store.save(sample);
    await store.delete(sample.channelId);
    expect(await store.get(sample.channelId)).toBeUndefined();
  });

  it("lists channels by client address", async () => {
    await store.save(sample);
    const other: ChannelState = {
      ...sample,
      channelId: "1",
      clientAddress: "0xother",
    };
    await store.save(other);

    const clientChannels = await store.listByClient("0xclient");
    expect(clientChannels.length).toBe(1);
    expect(clientChannels[0].channelId).toBe(sample.channelId);
  });
});

// ── WWW-Authenticate header parsing ───────────────────────────────────────

describe("WWW-Authenticate parsing", () => {
  function parseChallenge(header: string) {
    const id = header.match(/id="([^"]+)"/)?.[1];
    const method = header.match(/method="([^"]+)"/)?.[1];
    const intent = header.match(/intent="([^"]+)"/)?.[1];
    const request = header.match(/request="([^"]+)"/)?.[1];
    return { id, method, intent, request };
  }

  it("parses a well-formed challenge", () => {
    const header =
      'Payment id="550e8400-e29b-41d4-a716-446655440000", method="aptos", intent="charge", request="eyJhbW91bnQiOiIxMDAwMDAwIn0"';
    const parsed = parseChallenge(header);
    expect(parsed.id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(parsed.method).toBe("aptos");
    expect(parsed.intent).toBe("charge");
    expect(parsed.request).toBe("eyJhbW91bnQiOiIxMDAwMDAwIn0");
  });

  it("decodes base64url request payload", () => {
    const request = {
      amount: "1000000",
      currency: "USDC",
      recipient: "0x1",
      methodDetails: { network: "testnet", decimals: 6, acceptedTypes: ["transaction"] },
    };
    const encoded = Buffer.from(JSON.stringify(request)).toString("base64url");
    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8"));
    expect(decoded.amount).toBe("1000000");
  });
});

// ── PaymentError ───────────────────────────────────────────────────────────

describe("PaymentError", () => {
  it("serialises correctly with toJSON", async () => {
    const { PaymentError } = await import("../../src/server/Charge.js");
    const err = new PaymentError("payment_expired", "Challenge expired", true);
    const json = err.toJSON();
    expect(json.error).toBe("payment_expired");
    expect(json.message).toBe("Challenge expired");
    expect(json.retryable).toBe(true);
  });
});
