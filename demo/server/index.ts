/**
 * Demo Express server implementing two MPP-protected endpoints:
 *   GET /paid-pull   — pull mode (server broadcasts tx)
 *   GET /paid-push   — push mode (client broadcasts tx)
 *
 * Usage:
 *   SERVER_PRIVATE_KEY=0x... FEE_PAYER_PRIVATE_KEY=0x... npx tsx demo/server/index.ts
 */
import express from "express";
import { Account, Ed25519PrivateKey } from "@aptos-labs/ts-sdk";
import { MppxServer, PaymentError } from "../../src/server/Charge.js";
import { InMemoryStore } from "../../src/server/Store.js";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env variable: ${name}`);
  return val;
}

const serverPk = new Ed25519PrivateKey(requireEnv("SERVER_PRIVATE_KEY"));
const serverAccount = Account.fromPrivateKey({ privateKey: serverPk });
const feePayerPk = process.env["FEE_PAYER_PRIVATE_KEY"];

const mppx = MppxServer.create({
  feePayerPrivateKey: feePayerPk,
  methods: [
    {
      network: (process.env["APTOS_NETWORK"] as "mainnet" | "testnet" | "devnet" | "localnet") ?? "testnet",
      recipient: serverAccount.accountAddress.toString(),
      assetAddress: process.env["ASSET_ADDRESS"] || undefined,
      tokenStandard: (process.env["TOKEN_STANDARD"] as "coin" | "fa" | undefined) ?? "coin",
      decimals: Number(process.env["TOKEN_DECIMALS"] ?? "8"),
    },
  ],
  store: new InMemoryStore(),
});

const CHARGE_AMOUNT = process.env["CHARGE_AMOUNT"] ?? "100";
const CURRENCY = process.env["CURRENCY"] ?? "APT";

const app = express();
app.use(express.json());

// ── CORS (allow the demo frontend) ─────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, X-Aptos-Sender, Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, Payment-Receipt");
  next();
});

// ── Payment middleware ─────────────────────────────────────────────────────
async function paymentGuard(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  try {
    const handler = mppx.charge({
      amount: CHARGE_AMOUNT,
      currency: CURRENCY,
      externalId: crypto.randomUUID(),
      description: `Access to ${req.path}`,
    });

    // Pass Express headers (they are plain objects compatible with our signature)
    const result = await handler(req.headers as Record<string, string | string[] | undefined>);

    if (result.status === 402) {
      return res.status(402).set(result.headers).json(result.body);
    }

    // Payment settled — attach receipt header and continue
    res.setHeader("Payment-Receipt", result.receiptHeader);
    next();
  } catch (err) {
    if (err instanceof PaymentError) {
      return res.status(402).json(err.toJSON());
    }
    console.error(err);
    return res.status(500).json({ error: "internal_error", message: "Server error" });
  }
}

// ── Protected routes ───────────────────────────────────────────────────────
app.get("/paid-pull", paymentGuard, (_req, res) => {
  res.json({
    message: "Hello from the paid endpoint (pull mode)!",
    timestamp: new Date().toISOString(),
    data: { answer: 42 },
  });
});

app.get("/paid-push", paymentGuard, (_req, res) => {
  res.json({
    message: "Hello from the paid endpoint (push mode)!",
    timestamp: new Date().toISOString(),
    data: { answer: 42 },
  });
});

// ── Public health check ────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    server: serverAccount.accountAddress.toString(),
    network: process.env["APTOS_NETWORK"] ?? "testnet",
    chargeAmount: CHARGE_AMOUNT,
    currency: CURRENCY,
  });
});

const PORT = Number(process.env["PORT"] ?? 3000);
app.listen(PORT, () => {
  console.log(`MPP demo server listening on http://localhost:${PORT}`);
  console.log(`Server address: ${serverAccount.accountAddress.toString()}`);
  console.log(`Fee payer: ${feePayerPk ? "configured" : "not configured (no gas sponsorship)"}`);
  console.log(`Charge: ${CHARGE_AMOUNT} ${CURRENCY}`);
});
