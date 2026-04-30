/**
 * Integration test: full pull-mode charge flow against Aptos testnet.
 *
 * Prerequisites:
 *   1. Two funded Aptos testnet accounts (server and client).
 *   2. Environment variables set (copy .env.example → .env and fill in keys).
 *   3. Network access to https://api.testnet.aptoslabs.com
 *
 * Run with:
 *   CLIENT_PRIVATE_KEY=0x... SERVER_PRIVATE_KEY=0x... npm run test:integration
 *
 * The test charges 100 octas (APT base unit) from the client to the server.
 * Adjust CHARGE_AMOUNT in .env for a different amount.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  Aptos,
  AptosConfig,
  Network,
  Account,
  Ed25519PrivateKey,
} from "@aptos-labs/ts-sdk";
import { MppxServer } from "../../src/server/Charge.js";
import { MppxClient } from "../../src/client/Charge.js";
import { InMemoryStore } from "../../src/server/Store.js";

const SKIP_INTEGRATION = !process.env["CLIENT_PRIVATE_KEY"] || !process.env["SERVER_PRIVATE_KEY"];

describe.skipIf(SKIP_INTEGRATION)("Pull mode charge — devnet", () => {
  let serverAccount: Account;
  let clientAccount: Account;
  let mppxServer: MppxServer;
  let mppxClient: MppxClient;
  let aptos: Aptos;

  const CHARGE_AMOUNT = process.env["CHARGE_AMOUNT"] ?? "100";
  const CURRENCY = process.env["CURRENCY"] ?? "APT";
  const ASSET_ADDRESS = process.env["ASSET_ADDRESS"] || undefined;
  const TOKEN_STANDARD =
    (process.env["TOKEN_STANDARD"] as "coin" | "fa" | undefined) ?? "coin";
  const DECIMALS = Number(process.env["TOKEN_DECIMALS"] ?? "8");

  beforeAll(() => {
    const serverPk = new Ed25519PrivateKey(process.env["SERVER_PRIVATE_KEY"]!);
    const clientPk = new Ed25519PrivateKey(process.env["CLIENT_PRIVATE_KEY"]!);
    serverAccount = Account.fromPrivateKey({ privateKey: serverPk });
    clientAccount = Account.fromPrivateKey({ privateKey: clientPk });
    aptos = new Aptos(new AptosConfig({ network: Network.DEVNET }));
    mppxClient = MppxClient.create({
      methods: [{ signer: clientAccount }],
    });
  });

  // Fresh store per test so sequence locks from one test don't bleed into the next.
  beforeEach(() => {
    const feePayerPk = process.env["FEE_PAYER_PRIVATE_KEY"] || undefined;
    mppxServer = MppxServer.create({
      feePayerPrivateKey: feePayerPk,
      methods: [
        {
          network: "devnet",
          recipient: serverAccount.accountAddress.toString(),
          assetAddress: ASSET_ADDRESS,
          tokenStandard: TOKEN_STANDARD,
          decimals: DECIMALS,
        },
      ],
      store: new InMemoryStore(),
    });
  });

  it("issues a valid 402 challenge with a sequence number", async () => {
    const challenge = await mppxServer.issueChallenge({
      amount: CHARGE_AMOUNT,
      currency: CURRENCY,
      senderAddress: clientAccount.accountAddress.toString(),
    });

    expect(challenge.status).toBe(402);
    expect(challenge.headers["WWW-Authenticate"]).toContain('method="aptos"');
    expect(challenge.headers["WWW-Authenticate"]).toContain('intent="charge"');
    expect(challenge.challengeId).toBeTruthy();

    const requestRaw = challenge.headers["WWW-Authenticate"].match(/request="([^"]+)"/)?.[1];
    expect(requestRaw).toBeTruthy();
    const request = JSON.parse(Buffer.from(requestRaw!, "base64url").toString("utf-8"));
    expect(request.methodDetails.sequenceNumber).toBeTruthy();
  });

  it("full end-to-end pull mode (no fee payer)", async () => {
    // Step 1: issue challenge
    const challenge = await mppxServer.issueChallenge({
      amount: CHARGE_AMOUNT,
      currency: CURRENCY,
      senderAddress: clientAccount.accountAddress.toString(),
    });

    const wwwAuth = challenge.headers["WWW-Authenticate"];

    // Step 2: client fulfils challenge (pull mode, no hash)
    const authHeaderValue = await mppxClient.fulfillChallenge(wwwAuth, false);
    expect(authHeaderValue.startsWith("Payment ")).toBe(true);

    // Step 3: server verifies and settles
    const receipt = await mppxServer.verifyAndSettle(authHeaderValue);

    expect(receipt.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(receipt.challengeId).toBe(challenge.challengeId);
    expect(receipt.amount).toBe(CHARGE_AMOUNT);
    expect(receipt.network).toBe("devnet");
  });

  it("rejects a replayed credential", async () => {
    // Issue and settle once
    const challenge = await mppxServer.issueChallenge({
      amount: CHARGE_AMOUNT,
      currency: CURRENCY,
      senderAddress: clientAccount.accountAddress.toString(),
    });
    const authHeader = await mppxClient.fulfillChallenge(
      challenge.headers["WWW-Authenticate"],
      false,
    );
    await mppxServer.verifyAndSettle(authHeader);

    // Attempt to replay — must throw
    await expect(mppxServer.verifyAndSettle(authHeader)).rejects.toMatchObject({
      code: "payment_already_processed",
    });
  });
});
