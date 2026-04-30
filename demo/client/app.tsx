/**
 * Demo client script — Node.js / browser-compatible.
 *
 * Simulates both pull and push charge flows against the demo server.
 * Run in Node with:
 *   CLIENT_PRIVATE_KEY=0x... npx tsx demo/client/app.tsx
 */
import { Account, Ed25519PrivateKey } from "@aptos-labs/ts-sdk";
import { MppxClient } from "../../src/client/Charge.js";

const SERVER_BASE = process.env["SERVER_URL"] ?? "http://localhost:3000";

async function requireEnv(name: string): Promise<string> {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing env var: ${name}`);
    process.exit(1);
  }
  return val;
}

async function main() {
  const clientPkHex = await requireEnv("CLIENT_PRIVATE_KEY");
  const clientPk = new Ed25519PrivateKey(clientPkHex);
  const clientAccount = Account.fromPrivateKey({ privateKey: clientPk });

  console.log("Client address:", clientAccount.accountAddress.toString());

  const mppxClient = MppxClient.create({
    methods: [{ signer: clientAccount }],
  });

  // ── Health check ─────────────────────────────────────────────────────────
  const health = await fetch(`${SERVER_BASE}/health`).then((r) => r.json());
  console.log("\n[Health]", health);

  // ── Pull mode ─────────────────────────────────────────────────────────────
  console.log("\n── Pull mode (server broadcasts) ──");
  try {
    const pullResponse = await mppxClient.fetch(`${SERVER_BASE}/paid-pull`);
    const receipt = pullResponse.headers.get("payment-receipt");
    const body = await pullResponse.json();
    console.log("Status:", pullResponse.status);
    console.log("Payment-Receipt:", receipt);
    console.log("Body:", body);
  } catch (err) {
    console.error("Pull mode error:", err);
  }

  // ── Push mode ─────────────────────────────────────────────────────────────
  console.log("\n── Push mode (client broadcasts) ──");
  try {
    const pushResponse = await mppxClient.fetch(
      `${SERVER_BASE}/paid-push`,
      {},
      true, // preferHash = push mode
    );
    const receipt = pushResponse.headers.get("payment-receipt");
    const body = await pushResponse.json();
    console.log("Status:", pushResponse.status);
    console.log("Payment-Receipt:", receipt);
    console.log("Body:", body);
  } catch (err) {
    console.error("Push mode error:", err);
  }
}

main().catch(console.error);
