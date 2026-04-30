import { describe, it, expect, beforeEach } from "vitest";
import {
  ChargeRequestSchema,
  PaymentCredentialSchema,
  AptosMethodDetailsSchema,
} from "../../src/protocol.js";
import { InMemoryStore } from "../../src/server/Store.js";
import { MppxServer } from "../../src/server/Charge.js";

// ── Schema validation ──────────────────────────────────────────────────────

describe("ChargeRequestSchema", () => {
  it("accepts a valid charge request", () => {
    const input = {
      amount: "1000000",
      currency: "USDC",
      recipient: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      methodDetails: {
        network: "testnet",
        tokenStandard: "fa",
        decimals: 6,
        acceptedTypes: ["transaction", "hash"],
      },
    };
    expect(() => ChargeRequestSchema.parse(input)).not.toThrow();
  });

  it("rejects a non-integer amount string", () => {
    const input = {
      amount: "1.5",
      currency: "APT",
      recipient: "0x1",
      methodDetails: { network: "testnet", decimals: 8, acceptedTypes: ["transaction"] },
    };
    expect(() => ChargeRequestSchema.parse(input)).toThrow();
  });

  it("rejects invalid network", () => {
    const input = {
      amount: "100",
      currency: "APT",
      recipient: "0x1",
      methodDetails: { network: "solana", decimals: 8, acceptedTypes: ["transaction"] },
    };
    expect(() => ChargeRequestSchema.parse(input)).toThrow();
  });

  it("rejects more than 5 splits", () => {
    const split = {
      recipient: "0x1",
      amount: "100",
    };
    const input = {
      amount: "600",
      currency: "APT",
      recipient: "0x2",
      methodDetails: {
        network: "testnet",
        decimals: 8,
        acceptedTypes: ["transaction"],
        splits: [split, split, split, split, split, split],
      },
    };
    expect(() => ChargeRequestSchema.parse(input)).toThrow();
  });

  it("applies default acceptedTypes when omitted", () => {
    const input = {
      amount: "100",
      currency: "APT",
      recipient: "0x1",
      methodDetails: { network: "testnet", decimals: 8 },
    };
    const result = ChargeRequestSchema.parse(input);
    expect(result.methodDetails.acceptedTypes).toEqual(["transaction", "hash"]);
  });
});

describe("PaymentCredentialSchema", () => {
  it("parses a pull-mode credential", () => {
    const cred = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      method: "aptos",
      intent: "charge",
      payload: {
        type: "transaction",
        transaction: '{"rawTransaction":"deadbeef","senderAuthenticator":"cafebabe"}',
      },
    };
    expect(() => PaymentCredentialSchema.parse(cred)).not.toThrow();
  });

  it("parses a push-mode credential", () => {
    const cred = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      method: "aptos",
      intent: "charge",
      payload: {
        type: "hash",
        hash: "0x" + "a".repeat(64),
      },
    };
    expect(() => PaymentCredentialSchema.parse(cred)).not.toThrow();
  });

  it("rejects a push-mode credential with a short hash", () => {
    const cred = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      method: "aptos",
      intent: "charge",
      payload: { type: "hash", hash: "0xdeadbeef" },
    };
    expect(() => PaymentCredentialSchema.parse(cred)).toThrow();
  });
});

// ── InMemoryStore ──────────────────────────────────────────────────────────

describe("InMemoryStore", () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = new InMemoryStore();
  });

  it("marks a challenge as used and rejects a second mark", async () => {
    const first = await store.markUsed("id-1", 60);
    expect(first).toBe(true);
    const second = await store.markUsed("id-1", 60);
    expect(second).toBe(false);
  });

  it("reports isUsed correctly", async () => {
    expect(await store.isUsed("id-2")).toBe(false);
    await store.markUsed("id-2", 60);
    expect(await store.isUsed("id-2")).toBe(true);
  });

  it("locks a sequence number and rejects a second lock", async () => {
    const first = await store.lockSequenceNumber("0xabc", "challenge-1", 60);
    expect(first).toBe(true);
    const second = await store.lockSequenceNumber("0xabc", "challenge-2", 60);
    expect(second).toBe(false);
  });

  it("unlocks a sequence number and allows re-locking", async () => {
    await store.lockSequenceNumber("0xdef", "chal-a", 60);
    await store.unlockSequenceNumber("0xdef");
    const second = await store.lockSequenceNumber("0xdef", "chal-b", 60);
    expect(second).toBe(true);
  });

  it("stores and retrieves a challenge record", async () => {
    const record = {
      challengeId: "uuid-1",
      amount: "1000000",
      currency: "USDC",
      recipient: "0xrecipient",
      createdAt: Date.now(),
    };
    await store.storeChallenge("uuid-1", record, 60);
    const retrieved = await store.getChallenge("uuid-1");
    expect(retrieved).toMatchObject(record);
  });

  it("returns undefined for an unknown challenge", async () => {
    const retrieved = await store.getChallenge("nonexistent");
    expect(retrieved).toBeUndefined();
  });
});

// ── Challenge encoding round-trip ──────────────────────────────────────────

describe("Challenge encoding", () => {
  it("base64url-encodes and decodes a ChargeRequest round-trip", () => {
    const request = {
      amount: "500000",
      currency: "APT",
      recipient: "0xdeadbeef",
      methodDetails: {
        network: "testnet" as const,
        decimals: 8,
        acceptedTypes: ["transaction", "hash"] as ["transaction", "hash"],
      },
    };

    const encoded = Buffer.from(JSON.stringify(request)).toString("base64url");
    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8"));
    const parsed = ChargeRequestSchema.parse(decoded);
    expect(parsed.amount).toBe("500000");
    expect(parsed.methodDetails.network).toBe("testnet");
  });
});
