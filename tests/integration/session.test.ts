/**
 * Integration tests for the session (payment channel) flow.
 *
 * Two describe groups:
 *
 *  1. "Session voucher flow (offline)"
 *     Requires only CLIENT_PRIVATE_KEY and SERVER_PRIVATE_KEY.
 *     Channel state is pre-seeded into an InMemoryChannelStore so no
 *     deployed Move contract is needed. Tests real Ed25519 signing and
 *     the server's voucher-verification logic end-to-end.
 *
 *  2. "Session channel lifecycle — devnet (on-chain)"
 *     Requires CHANNEL_MODULE_ADDRESS in addition.
 *     Exercises the full flow: challenge → open_channel tx → registerChannel
 *     (reads public key from the Move contract) → multiple voucher rounds.
 *
 * Prerequisites for group 2:
 *   1. Deploy the Move contract:  aptos move publish --named-addresses aptos_mpp=<your-addr>
 *   2. Call initialize():         aptos move run --function-id <addr>::channel::initialize
 *   3. Set env vars (copy .env.example → .env):
 *        CLIENT_PRIVATE_KEY, SERVER_PRIVATE_KEY, CHANNEL_MODULE_ADDRESS, APTOS_NETWORK
 *   4. Both accounts must be funded (use the devnet faucet).
 *
 * Run with:
 *   npm run test:integration
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  Aptos,
  AptosConfig,
  Network,
  Account,
  AccountAddress,
  Ed25519PrivateKey,
} from "@aptos-labs/ts-sdk";
import { MppxSessionServer } from "../../src/server/Session.js";
import { MppxSessionClient } from "../../src/client/Session.js";
import { InMemoryChannelStore } from "../../src/session/ChannelStore.js";
import { signVoucher } from "../../src/session/voucher.js";
import type { ChannelState } from "../../src/session/types.js";
import type { BuildOpenChannelTx, BuildTopupTx } from "../../src/session/types.js";
import { APTOS_NETWORKS } from "../../src/constants.js";

// ── Env ───────────────────────────────────────────────────────────────────

const CLIENT_KEY   = process.env["CLIENT_PRIVATE_KEY"];
const SERVER_KEY   = process.env["SERVER_PRIVATE_KEY"];
const MODULE_ADDR  = process.env["CHANNEL_MODULE_ADDRESS"];
const NETWORK_ENV  = (process.env["APTOS_NETWORK"] ?? "devnet") as
  "mainnet" | "testnet" | "devnet" | "localnet";
const ASSET_ADDR   = process.env["ASSET_ADDRESS"] || undefined;
const DECIMALS     = Number(process.env["TOKEN_DECIMALS"] ?? "8");

// Native APT fungible-asset metadata address (same on all official networks)
const APT_FA_META = "0x000000000000000000000000000000000000000000000000000000000000000a";

const HAVE_ACCOUNTS  = Boolean(CLIENT_KEY && SERVER_KEY);
const HAVE_CONTRACT  = Boolean(HAVE_ACCOUNTS && MODULE_ADDR);

// ── Helpers ───────────────────────────────────────────────────────────────

function makeAptosClient(network: string): Aptos {
  const net = APTOS_NETWORKS[network] ?? Network.DEVNET;
  return new Aptos(new AptosConfig({ network: net }));
}

/**
 * Default buildOpenChannelTx for tests against the standard Move contract.
 * Opens a channel by calling `<MODULE_ADDR>::channel::open_channel`.
 */
function makeOpenChannelTx(moduleAddress: string): BuildOpenChannelTx {
  return async (params) => {
    const aptos = makeAptosClient(params.network);

    // Raw 32-byte Ed25519 public key (no 0x prefix) for on-chain storage
    const rawPub = params.signer.publicKey.toString().replace(/^0x/, "");
    const pubKeyBytes = new Uint8Array(Buffer.from(rawPub, "hex"));

    const metaAddress = params.assetAddress ?? APT_FA_META;

    const tx = await aptos.transaction.build.simple({
      sender: params.signer.accountAddress,
      data: {
        function:          `${moduleAddress}::channel::open_channel`,
        typeArguments:     [],
        functionArguments: [
          AccountAddress.from(params.recipientAddress),
          AccountAddress.from(metaAddress),
          BigInt(params.depositAmount),
          BigInt(params.expiryTimestamp),
          pubKeyBytes,
        ],
      },
    });

    const auth    = aptos.transaction.sign({ signer: params.signer, transaction: tx });
    const pending = await aptos.transaction.submit.simple({
      transaction:          tx,
      senderAuthenticator:  auth,
    });

    await aptos.waitForTransaction({ transactionHash: pending.hash });
    return pending.hash;
  };
}

/**
 * Default buildTopupTx for tests against the standard Move contract.
 */
function makeTopupTx(moduleAddress: string): BuildTopupTx {
  return async (params) => {
    const aptos = makeAptosClient(params.network);
    const metaAddress = ASSET_ADDR ?? APT_FA_META;

    const tx = await aptos.transaction.build.simple({
      sender: params.signer.accountAddress,
      data: {
        function:          `${moduleAddress}::channel::topup_channel`,
        typeArguments:     [],
        functionArguments: [
          BigInt(params.channelId),
          AccountAddress.from(metaAddress),
          BigInt(params.additionalAmount),
        ],
      },
    });

    const auth    = aptos.transaction.sign({ signer: params.signer, transaction: tx });
    const pending = await aptos.transaction.submit.simple({
      transaction:          tx,
      senderAuthenticator:  auth,
    });

    await aptos.waitForTransaction({ transactionHash: pending.hash });
    return pending.hash;
  };
}

// ── Group 1: offline voucher flow (no contract required) ──────────────────

describe.skipIf(!HAVE_ACCOUNTS)("Session voucher flow (offline)", () => {
  let clientAccount: Account;
  let serverAccount: Account;
  let store: InMemoryChannelStore;
  let sessionServer: MppxSessionServer;
  let baseChannel: ChannelState;

  const channelId = "42";
  const deposit   = 10_000_000n;

  beforeAll(() => {
    clientAccount = Account.fromPrivateKey({
      privateKey: new Ed25519PrivateKey(CLIENT_KEY!),
    });
    serverAccount = Account.fromPrivateKey({
      privateKey: new Ed25519PrivateKey(SERVER_KEY!),
    });
  });

  beforeEach(async () => {
    store = new InMemoryChannelStore();

    const rawPub = clientAccount.publicKey.toString().replace(/^0x/, "");

    baseChannel = {
      channelId,
      clientAddress:    clientAccount.accountAddress.toString(),
      clientPublicKey:  rawPub,
      recipientAddress: serverAccount.accountAddress.toString(),
      assetAddress:     ASSET_ADDR,
      tokenStandard:    "coin",
      depositedAmount:  deposit,
      cumulativePaid:   0n,
      lastNonce:        0,
      expiryTimestamp:  Math.floor(Date.now() / 1000) + 3600,
      openTxHash:       "0x" + "ab".repeat(32),
      network:          NETWORK_ENV,
    };
    await store.save(baseChannel);

    sessionServer = MppxSessionServer.create({
      methods: [{
        network:              NETWORK_ENV,
        recipient:            serverAccount.accountAddress.toString(),
        assetAddress:         ASSET_ADDR,
        tokenStandard:        "coin",
        decimals:             DECIMALS,
        channelModuleAddress: MODULE_ADDR ?? "0x1", // unused by verifyVoucher
        pricing:   { unit: "request", amountPerUnit: "100" },
        sessionDefaults: { suggestedDeposit: "1000000", ttlSeconds: 3600 },
      }],
      store,
    });
  });

  it("server issues a valid session challenge", async () => {
    const resp = await sessionServer.issueSessionChallenge({
      clientAddress: clientAccount.accountAddress.toString(),
    });
    expect(resp.status).toBe(402);
    expect(resp.headers["WWW-Authenticate"]).toContain('method="aptos"');
    expect(resp.headers["WWW-Authenticate"]).toContain('intent="session"');
    const encoded = resp.headers["WWW-Authenticate"].match(/request="([^"]+)"/)?.[1];
    expect(encoded).toBeTruthy();
    const req = JSON.parse(Buffer.from(encoded!, "base64url").toString("utf-8"));
    expect(req.recipient).toBeTruthy();
  });

  it("server accepts a valid voucher signed by the client", async () => {
    const expiry   = Math.floor(Date.now() / 1000) + 60;
    const nonce    = 1;
    const amount   = 1_000n;
    const voucher  = await signVoucher(clientAccount, channelId, amount, nonce, expiry);

    const credential = {
      id:      "550e8400-e29b-41d4-a716-446655440000",
      method:  "aptos",
      intent:  "session",
      payload: voucher,
    };
    const authHeader = `Payment ${Buffer.from(JSON.stringify(credential)).toString("base64url")}`;

    const result = await sessionServer.verifyVoucher(authHeader);
    expect(result.channelId).toBe(channelId);
    expect(result.cumulativePaid).toBe(amount);
  });

  it("server rejects a voucher with an invalid signature", async () => {
    const other   = Account.generate();
    const expiry  = Math.floor(Date.now() / 1000) + 60;
    // Signed by a DIFFERENT key — server must reject
    const voucher = await signVoucher(other, channelId, 1_000n, 1, expiry);

    const credential = {
      id:      "550e8400-e29b-41d4-a716-446655440001",
      method:  "aptos",
      intent:  "session",
      payload: voucher,
    };
    const authHeader = `Payment ${Buffer.from(JSON.stringify(credential)).toString("base64url")}`;

    await expect(sessionServer.verifyVoucher(authHeader)).rejects.toThrow(
      "Voucher signature is invalid",
    );
  });

  it("server rejects a stale nonce", async () => {
    // Advance the channel so lastNonce = 5
    await store.update(channelId, { lastNonce: 5, cumulativePaid: 5_000n });

    const expiry  = Math.floor(Date.now() / 1000) + 60;
    // Replay nonce 3 — must be rejected
    const voucher = await signVoucher(clientAccount, channelId, 6_000n, 3, expiry);

    const credential = {
      id:      "550e8400-e29b-41d4-a716-446655440002",
      method:  "aptos",
      intent:  "session",
      payload: voucher,
    };
    const authHeader = `Payment ${Buffer.from(JSON.stringify(credential)).toString("base64url")}`;

    await expect(sessionServer.verifyVoucher(authHeader)).rejects.toThrow("Stale nonce");
  });

  it("server rejects a non-monotonic cumulative amount", async () => {
    // Settle 5_000 first
    await store.update(channelId, { lastNonce: 1, cumulativePaid: 5_000n });

    const expiry  = Math.floor(Date.now() / 1000) + 60;
    // New voucher claims cumulative=4_000 (less than current 5_000)
    const voucher = await signVoucher(clientAccount, channelId, 4_000n, 2, expiry);

    const credential = {
      id:      "550e8400-e29b-41d4-a716-446655440003",
      method:  "aptos",
      intent:  "session",
      payload: voucher,
    };
    const authHeader = `Payment ${Buffer.from(JSON.stringify(credential)).toString("base64url")}`;

    await expect(sessionServer.verifyVoucher(authHeader)).rejects.toThrow();
  });

  it("server rejects an expired voucher", async () => {
    const expiredExpiry = Math.floor(Date.now() / 1000) - 10; // 10 seconds ago
    const voucher       = await signVoucher(clientAccount, channelId, 1_000n, 1, expiredExpiry);

    const credential = {
      id:      "550e8400-e29b-41d4-a716-446655440004",
      method:  "aptos",
      intent:  "session",
      payload: voucher,
    };
    const authHeader = `Payment ${Buffer.from(JSON.stringify(credential)).toString("base64url")}`;

    await expect(sessionServer.verifyVoucher(authHeader)).rejects.toThrow("expired");
  });

  it("server accumulates cumulativePaid across sequential vouchers", async () => {
    const expiry = Math.floor(Date.now() / 1000) + 60;

    for (let i = 1; i <= 5; i++) {
      const cumulative = BigInt(i) * 1_000n;
      const voucher    = await signVoucher(clientAccount, channelId, cumulative, i, expiry);
      const credential = {
        id:      `550e8400-e29b-41d4-a716-44665544000${i}`,
        method:  "aptos",
        intent:  "session",
        payload: voucher,
      };
      const authHeader = `Payment ${Buffer.from(JSON.stringify(credential)).toString("base64url")}`;

      const result = await sessionServer.verifyVoucher(authHeader);
      expect(result.cumulativePaid).toBe(cumulative);
    }

    const finalState = await store.get(channelId);
    expect(finalState?.cumulativePaid).toBe(5_000n);
    expect(finalState?.lastNonce).toBe(5);
  });
});

// ── Group 2: full on-chain session lifecycle ──────────────────────────────

describe.skipIf(!HAVE_CONTRACT)("Session channel lifecycle — devnet (on-chain)", () => {
  let clientAccount:  Account;
  let serverAccount:  Account;
  let sessionServer:  MppxSessionServer;
  let sessionClient:  MppxSessionClient;

  // 10_000 octas deposit, 100 octas per request
  const DEPOSIT_AMOUNT      = "10000";
  const AMOUNT_PER_REQUEST  = 100n;

  beforeAll(() => {
    clientAccount = Account.fromPrivateKey({
      privateKey: new Ed25519PrivateKey(CLIENT_KEY!),
    });
    serverAccount = Account.fromPrivateKey({
      privateKey: new Ed25519PrivateKey(SERVER_KEY!),
    });
  });

  beforeEach(() => {
    const store = new InMemoryChannelStore();

    sessionServer = MppxSessionServer.create({
      methods: [{
        network:              NETWORK_ENV,
        recipient:            serverAccount.accountAddress.toString(),
        assetAddress:         ASSET_ADDR,
        tokenStandard:        "coin",
        decimals:             DECIMALS,
        channelModuleAddress: MODULE_ADDR!,
        pricing:   { unit: "request", amountPerUnit: AMOUNT_PER_REQUEST.toString() },
        sessionDefaults: {
          suggestedDeposit: DEPOSIT_AMOUNT,
          ttlSeconds: 3600,
        },
      }],
      store,
    });

    sessionClient = MppxSessionClient.create({
      methods: [{
        signer:            clientAccount,
        authorizer:        { authorize: async (p) => {
          const { signVoucher: sv } = await import("../../src/session/voucher.js");
          const cumulative = p.currentCumulative + p.requestedAmount;
          const v = await sv(clientAccount, p.channelId, cumulative, p.nonce, p.expiry);
          return { cumulativeAmount: cumulative, signature: v.signature };
        }},
        buildOpenChannelTx: makeOpenChannelTx(MODULE_ADDR!),
        buildTopupTx:       makeTopupTx(MODULE_ADDR!),
      }],
    });
  });

  it("opens a payment channel on-chain and registers it with the server", async () => {
    const challenge = await sessionServer.issueSessionChallenge({
      clientAddress: clientAccount.accountAddress.toString(),
    });
    const wwwAuth   = challenge.headers["WWW-Authenticate"];

    const channelId = await sessionClient.openChannel(wwwAuth, DEPOSIT_AMOUNT);
    expect(channelId).toBeTruthy();

    // The channel state is held on the client — retrieve the open tx hash to register
    // We access it through the channel property via the client's internal state.
    // registerChannel reads the client public key from the on-chain view function.
    const clientAddr = clientAccount.accountAddress.toString();
    await sessionServer.registerChannel({
      channelId,
      clientAddress:  clientAddr,
      depositAmount:  DEPOSIT_AMOUNT,
      openTxHash:     "0x" + "00".repeat(32), // openTxHash stored but not re-verified here
    });

    // Confirm the server now knows the channel
    const store = (sessionServer as unknown as { store: InMemoryChannelStore }).store;
    const saved = await store.get(channelId);
    expect(saved).toBeDefined();
    expect(saved?.clientAddress).toBe(clientAddr);
    // Public key was read from chain — should be 64 hex chars (32 bytes)
    expect(saved?.clientPublicKey).toMatch(/^[0-9a-fA-F]{64}$/);
  }, 60_000);

  it("authorizes and verifies three sequential payment requests", async () => {
    // Open channel
    const challenge = await sessionServer.issueSessionChallenge({});
    const wwwAuth   = challenge.headers["WWW-Authenticate"];
    const channelId = await sessionClient.openChannel(wwwAuth, DEPOSIT_AMOUNT);

    await sessionServer.registerChannel({
      channelId,
      clientAddress:  clientAccount.accountAddress.toString(),
      depositAmount:  DEPOSIT_AMOUNT,
      openTxHash:     "0x" + "00".repeat(32),
    });

    // Three consecutive voucher rounds
    let expectedCumulative = 0n;
    for (let i = 1; i <= 3; i++) {
      expectedCumulative += AMOUNT_PER_REQUEST;

      const authHeader = await sessionClient.authorizeRequest(
        `550e8400-e29b-41d4-a716-44665544000${i}`,
        AMOUNT_PER_REQUEST,
      );

      const result = await sessionServer.verifyVoucher(authHeader);
      expect(result.channelId).toBe(channelId);
      expect(result.cumulativePaid).toBe(expectedCumulative);
    }
  }, 90_000);

  it("rejects a tampered voucher even with a valid-looking credential", async () => {
    const challenge = await sessionServer.issueSessionChallenge({});
    const channelId = await sessionClient.openChannel(
      challenge.headers["WWW-Authenticate"],
      DEPOSIT_AMOUNT,
    );
    await sessionServer.registerChannel({
      channelId,
      clientAddress: clientAccount.accountAddress.toString(),
      depositAmount: DEPOSIT_AMOUNT,
      openTxHash:    "0x" + "00".repeat(32),
    });

    // Get a legitimate auth header
    const authHeader = await sessionClient.authorizeRequest(
      "550e8400-e29b-41d4-a716-446655440001",
      AMOUNT_PER_REQUEST,
    );

    // Tamper: inflate the cumulativeAmount in the base64url payload
    const encoded    = authHeader.slice("Payment ".length);
    const credential = JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8"));
    credential.payload.cumulativeAmount = "999999999";
    const tampered   = `Payment ${Buffer.from(JSON.stringify(credential)).toString("base64url")}`;

    await expect(sessionServer.verifyVoucher(tampered)).rejects.toThrow(
      "Voucher signature is invalid",
    );
  }, 90_000);
});
