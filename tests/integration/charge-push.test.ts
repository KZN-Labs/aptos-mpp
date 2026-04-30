/**
 * Integration test: push-mode charge flow against Aptos testnet.
 *
 * In push mode the client broadcasts the transaction and sends only the hash.
 * This is the fallback when fee sponsorship is not desired.
 *
 * Same prerequisites as charge-pull.test.ts.
 */

import { describe, it, expect, beforeAll } from "vitest";
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

describe.skipIf(SKIP_INTEGRATION)("Push mode charge — devnet", () => {
  let serverAccount: Account;
  let clientAccount: Account;
  let mppxServer: MppxServer;
  let mppxClient: MppxClient;

  const CHARGE_AMOUNT = process.env["CHARGE_AMOUNT"] ?? "100";
  const CURRENCY = process.env["CURRENCY"] ?? "APT";
  const TOKEN_STANDARD =
    (process.env["TOKEN_STANDARD"] as "coin" | "fa" | undefined) ?? "coin";
  const DECIMALS = Number(process.env["TOKEN_DECIMALS"] ?? "8");

  beforeAll(() => {
    const serverPk = new Ed25519PrivateKey(process.env["SERVER_PRIVATE_KEY"]!);
    const clientPk = new Ed25519PrivateKey(process.env["CLIENT_PRIVATE_KEY"]!);
    serverAccount = Account.fromPrivateKey({ privateKey: serverPk });
    clientAccount = Account.fromPrivateKey({ privateKey: clientPk });

    mppxServer = MppxServer.create({
      methods: [
        {
          network: "devnet",
          recipient: serverAccount.accountAddress.toString(),
          assetAddress: process.env["ASSET_ADDRESS"] || undefined,
          tokenStandard: TOKEN_STANDARD,
          decimals: DECIMALS,
        },
      ],
      store: new InMemoryStore(),
    });

    mppxClient = MppxClient.create({
      methods: [{ signer: clientAccount }],
    });
  });

  it("push mode: client broadcasts, server verifies hash", async () => {
    // Step 1: server issues challenge
    const challenge = await mppxServer.issueChallenge({
      amount: CHARGE_AMOUNT,
      currency: CURRENCY,
      senderAddress: clientAccount.accountAddress.toString(),
    });

    // Step 2: client uses push mode (preferHash = true)
    const authHeader = await mppxClient.fulfillChallenge(
      challenge.headers["WWW-Authenticate"],
      true, // preferHash → push mode
    );

    expect(authHeader.startsWith("Payment ")).toBe(true);

    // Decode to verify it's a hash payload
    const encoded = authHeader.slice("Payment ".length);
    const cred = JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8"));
    expect(cred.payload.type).toBe("hash");
    expect(cred.payload.hash).toMatch(/^0x[0-9a-fA-F]{64}$/);

    // Step 3: server verifies on-chain
    const receipt = await mppxServer.verifyAndSettle(authHeader);
    expect(receipt.txHash).toBe(cred.payload.hash);
    expect(receipt.network).toBe("devnet");
  });
});
