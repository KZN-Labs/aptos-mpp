# `@aptos/mpp` — Aptos Payment Method for the Machine Payments Protocol

> **Status:** Phase 1–3 complete · Phase 4 (sessions) partial · Phase 5 (production hardening) pending
> **Spec base:** [HTTP Payment Authentication Scheme](https://paymentauth.org/draft-httpauth-payment-00.html) + [Charge Intent](https://paymentauth.org/draft-payment-intent-charge-00.html)

---

## Table of Contents

1. [What This Is](#1-what-this-is)
2. [Background — The MPP Protocol](#2-background--the-mpp-protocol)
3. [Why Aptos Specifically](#3-why-aptos-specifically)
4. [Architecture Overview](#4-architecture-overview)
5. [Aptos-Specific Design Decisions](#5-aptos-specific-design-decisions)
6. [Request Schema](#6-request-schema)
7. [Credential Schema](#7-credential-schema)
8. [Charge Flow — Step by Step](#8-charge-flow--step-by-step)
9. [Session Flow — Step by Step](#9-session-flow--step-by-step)
10. [Fee Sponsorship](#10-fee-sponsorship)
11. [Replay Protection](#11-replay-protection)
12. [Verification Procedure](#12-verification-procedure)
13. [Settlement Procedure](#13-settlement-procedure)
14. [Error Handling](#14-error-handling)
15. [Security Considerations](#15-security-considerations)
16. [Repository Structure](#16-repository-structure)
17. [Package API](#17-package-api)
18. [Testing — End to End](#18-testing--end-to-end)
19. [Implementation Checklist](#19-implementation-checklist)
20. [References](#20-references)

---

## 1. What This Is

This repository implements the **Aptos payment method** for the [Machine Payments Protocol (MPP)](https://mpp.dev) — an open protocol that lets any HTTP API require payment before serving a response, using the long-dormant HTTP `402 Payment Required` status code.

MPP is chain-agnostic. Each blockchain registers its own payment method implementation. This repo is the Aptos implementation.

This SDK is not a Tempo product. It implements an open protocol spec. Users do not need a Tempo wallet — any Aptos wallet or keypair signer works as the paying client.

---

## 2. Background — The MPP Protocol

### The 402 Payment Required Flow

MPP standardises HTTP 402 as a payment challenge-response mechanism defined in [draft-httpauth-payment-00](https://paymentauth.org/draft-httpauth-payment-00.html):

```
Client                                             Server
  │                                                   │
  │  (1) GET /resource                                │
  ├──────────────────────────────────────────────────>│
  │                                                   │
  │  (2) HTTP 402 Payment Required                    │
  │      WWW-Authenticate: Payment                    │
  │        id="uuid", method="aptos",                 │
  │        intent="charge", request="<base64url-JSON>"│
  │<──────────────────────────────────────────────────┤
  │                                                   │
  │  (3) Client fulfils challenge                     │
  │      (builds + signs Aptos transaction)           │
  │                                                   │
  │  (4) GET /resource                                │
  │      Authorization: Payment <base64url-credential>│
  ├──────────────────────────────────────────────────>│
  │                                                   │
  │  (5) Server verifies + settles on-chain           │
  │                                                   │
  │  (6) 200 OK                                       │
  │      Payment-Receipt: <receipt>                   │
  │<──────────────────────────────────────────────────┤
```

### Key Concepts

| Term | Meaning |
|---|---|
| **Payment Challenge** | `WWW-Authenticate` header returned with 402. Contains payment instructions. |
| **Payment Credential** | `Authorization` header containing proof of payment (signed tx or hash). |
| **Payment Intent** | The type of payment: `charge` (one-time) or `session` (metered/streaming). |
| **Payment Method** | Chain-specific identifier: `"aptos"` in this case. |
| **Request** | Method-specific JSON in the challenge (base64url-encoded). Tells the client what to pay, how much, to whom. |
| **Payload** | Method-specific JSON in the credential (base64url-encoded). Proof the payment was made. |
| **Payment-Receipt** | Response header confirming settlement with on-chain proof. |

### Settlement Modes

Every chain implementation must support at least one settlement mode:

- **Pull mode (`type="transaction"`, DEFAULT):** Client signs the transaction but does NOT broadcast it. Client sends the raw signed transaction bytes to the server. Server validates, simulates, broadcasts, and waits for confirmation. Server becomes fee payer (sponsorship).
- **Push mode (`type="hash"`, FALLBACK):** Client builds, signs, and broadcasts the transaction itself. Client presents the resulting on-chain transaction hash to the server. Server polls chain to verify. No fee sponsorship possible in this mode.

---

## 3. Why Aptos Specifically

- Aptos has fast finality, low fees, and a thriving Move ecosystem making it well-suited for micropayments.
- Aptos uses the **Aptos Account Model** with sequence numbers and Ed25519/multi-sig accounts, requiring a dedicated implementation distinct from other chains.
- Aptos's **Fungible Asset standard** (FA) is the successor to the older `coin` module. The implementation supports both legacy `aptos_coin::AptosCoin` and FA-standard tokens (especially USDC via Circle's Aptos deployment).
- No existing open-source Aptos MPP SDK existed before this. This is greenfield.

---

## 4. Architecture Overview

```
@aptos/mpp/
├── src/
│   ├── Methods.ts              # Shared charge + session schemas (Zod)
│   ├── constants.ts            # Token addresses, node URLs, chain IDs
│   ├── server/
│   │   ├── Charge.ts           # Server: issue challenge, verify, broadcast, settle
│   │   ├── Session.ts          # Server: session channel management
│   │   └── Store.ts            # Idempotency + sequence-lock store (pluggable)
│   ├── client/
│   │   ├── Charge.ts           # Client: build tx, sign, submit to server or broadcast
│   │   └── Session.ts          # Client: session lifecycle (open, topup, close)
│   └── session/
│       ├── Types.ts            # Session types + interfaces
│       ├── Voucher.ts          # Voucher signing + verification (Ed25519)
│       ├── ChannelStore.ts     # Persistent channel state (pluggable storage)
│       └── authorizers/        # Pluggable auth strategies
│           ├── Unbounded.ts
│           ├── RegularBudget.ts
│           └── index.ts
│   └── index.ts
├── demo/                       # Express server + Node demo client
│   ├── server/index.ts
│   └── client/app.tsx
├── move/
│   └── aptos_channel/          # Move smart contract for sessions
│       ├── Move.toml
│       └── sources/channel.move
├── tests/
│   ├── unit/
│   └── integration/
├── package.json
└── README.md
```

### Package Exports

```
@aptos/mpp          → shared schemas, session types, authorizers
@aptos/mpp/server   → server-side charge + session (MppxServer, InMemoryStore)
@aptos/mpp/client   → client-side charge + session (MppxClient)
```

---

## 5. Aptos-Specific Design Decisions

### 5.1 Transaction Model

- Every transaction has a **sender account** with a **sequence number**. The sequence number must match on-chain or the transaction is rejected.
- Transactions have an **expiry timestamp** (`expiration_timestamp_secs`). Stale transactions cannot be replayed after expiry.
- The gas fee payer is determined by a separate `fee_payer_address` field (introduced via [AIP-39](https://github.com/aptos-foundation/AIPs/blob/main/aips/aip-39.md)). Sponsored transactions require the fee payer to also sign the transaction.
- Aptos uses **BCS (Binary Canonical Serialization)** for transaction encoding.

### 5.2 Token Standards

Aptos has two token paradigms. Both are supported:

| Standard | Module | Notes |
|---|---|---|
| Legacy Coin | `0x1::coin::transfer<CoinType>` | AptosCoin (APT), older deployments |
| Fungible Asset (FA) | `0x1::primary_fungible_store::transfer` | Modern standard, Circle USDC on Aptos uses this |

The challenge `request` includes a `tokenStandard` hint (`"coin"` or `"fa"`). If absent, the client resolves from the asset address.

USDC on Aptos (FA standard):
- Mainnet asset address: `0xbae207659db88bea0cbead6da0c58b8b7a695f65ef13cf2f9de3e61d83d05a7b` *(verify before shipping — Circle updates this)*

### 5.3 Sequence Number Management

Aptos sequence numbers must be exact. In **pull mode**, the server must:

1. Fetch the current sequence number from the Aptos node before returning the challenge.
2. Include it in the challenge `request` as `sequenceNumber`.
3. Reserve/lock it to prevent double-use while the challenge is pending.

The server reads the sender's address from the optional `X-Aptos-Sender` request header. If no header is present, the server omits `sequenceNumber` and the client fetches it directly from the node.

If two concurrent 402 challenges are issued for the same sender, they'll collide on sequence number. The server uses a locking mechanism (Redis SETNX or in-memory with TTL) keyed on sender address.

### 5.4 Expiry Window

The challenge includes `expirationTimestampSecs`. Default: `Math.floor(Date.now() / 1000) + 120` (2 minutes). The client must not sign with a different expiry. Server must reject credentials where the transaction expiry deviates by more than 5 seconds from the challenge expiry.

### 5.5 Gas Fee Sponsorship

Aptos sponsored transactions (AIP-39) work as follows:
- Transaction includes `fee_payer_address` = server's sponsoring account address.
- Client signs the transaction with an empty fee payer address (sentinel value: `AccountAddress.ZERO`) — Aptos SDK handles this via `withFeePayer: true`.
- Server receives the partially-signed transaction, adds its own signature, then broadcasts.
- Result: client pays zero gas. Server pays gas on behalf of the client.

This is the **default mode** for pull mode transactions when `feePayerAddress` is included in the challenge.

### 5.6 Transaction Envelope Format

The `transaction` field in a pull-mode credential contains a JSON-encoded envelope:

```json
{
  "rawTransaction": "<hex>",
  "senderAuthenticator": "<hex>"
}
```

Where each hex string is the BCS-serialized bytes of the respective Aptos SDK type (`SimpleTransaction` and `AccountAuthenticator`). This allows the server to deserialize, co-sign, and broadcast independently.

---

## 6. Request Schema

The `request` field in `WWW-Authenticate` is base64url-encoded JSON. Structure:

```typescript
interface ChargeRequest {
  amount: string;             // Token amount in base units (e.g., "1000000" for 1 USDC with 6 decimals)
  currency: string;           // ISO 4217 or token symbol (e.g., "USDC", "APT")
  recipient: string;          // Aptos account address (0x prefixed, 32 bytes hex)
  description?: string;       // Human-readable payment reason
  externalId?: string;        // Opaque server-side correlation ID (UUID recommended)

  methodDetails: AptosMethodDetails;
}

interface AptosMethodDetails {
  network: "mainnet" | "testnet" | "devnet" | "localnet";
  assetAddress?: string;       // FA asset address or coin type string. Omit for native APT.
  tokenStandard?: "coin" | "fa"; // Hint; client resolves if absent
  decimals: number;            // Token decimal places (APT=8, USDC=6)
  
  // Pull mode fields (server provides these)
  sequenceNumber?: string;     // Sender's current sequence number (stringified u64)
  expirationTimestampSecs?: number; // Unix timestamp — transaction expiry
  
  // Fee sponsorship (optional)
  feePayerAddress?: string;    // Server's fee payer address (0x prefixed)
  feePayerPublicKey?: string;  // Server's fee payer Ed25519 public key (hex, no 0x)
  
  // Settlement modes the server accepts (in preference order)
  acceptedTypes?: Array<"transaction" | "hash">; // default: ["transaction", "hash"]
  
  // Payment splits (optional, up to 5 recipients)
  splits?: Array<{
    recipient: string;
    amount: string;
    description?: string;
  }>;
}
```

### Full Wire Example (Challenge)

```
HTTP/1.1 402 Payment Required
WWW-Authenticate: Payment
  id="a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  method="aptos",
  intent="charge",
  request="<base64url-encoded-JSON>"
```

---

## 7. Credential Schema

The `Authorization: Payment <credential>` header contains base64url-encoded JSON:

```typescript
interface PaymentCredential {
  id: string;           // The challenge ID from WWW-Authenticate
  method: "aptos";
  intent: "charge";
  payload: AptosChargePayload;
}

// Pull mode (type="transaction") — DEFAULT
interface AptosTransactionPayload {
  type: "transaction";
  transaction: string;  // JSON string: { rawTransaction: hex, senderAuthenticator: hex }
}

// Push mode (type="hash") — FALLBACK
interface AptosHashPayload {
  type: "hash";
  hash: string;         // On-chain transaction hash (0x prefixed, 32 bytes hex)
}
```

---

## 8. Charge Flow — Step by Step

### Pull Mode (Default, Recommended)

```
Client                         Server                     Aptos Node
  │                                │                           │
  │  GET /paid-resource            │                           │
  │  X-Aptos-Sender: 0xclient      │                           │
  ├──────────────────────────────>│                           │
  │                                │  getAccountInfo(0xclient) │
  │                                ├──────────────────────────>│
  │                                │<──────────────────────────┤
  │  402 + WWW-Authenticate        │                           │
  │  (amount, recipient, seqNo,    │                           │
  │   expiry, feePayerAddress)     │                           │
  │<───────────────────────────────┤                           │
  │                                │                           │
  │  Build SimpleTransaction       │                           │
  │  withFeePayer: true            │                           │
  │  Sign with client key          │                           │
  │                                │                           │
  │  Authorization: Payment {...}  │                           │
  │  (JSON envelope: rawTx+auth)   │                           │
  ├──────────────────────────────>│                           │
  │                                │                           │
  │                                │  Deserialize + verify     │
  │                                │  Simulate transaction     │
  │                                ├──────────────────────────>│
  │                                │<──────────────────────────┤
  │                                │  Add fee payer signature  │
  │                                │  Submit transaction       │
  │                                ├──────────────────────────>│
  │                                │  Wait for confirmation    │
  │                                │<──────────────────────────┤
  │                                │                           │
  │  200 OK                        │                           │
  │  Payment-Receipt: {...}        │                           │
  │<───────────────────────────────┤                           │
```

### Push Mode (Fallback)

```
Client                         Server                     Aptos Node
  │  (1) GET /paid-resource       │                           │
  ├──────────────────────────────>│                           │
  │  (2) 402 Payment Required     │                           │
  │<───────────────────────────────┤                           │
  │  (3) Build + sign + submit tx  │                           │
  ├─────────────────────────────────────────────────────────>│
  │<─────────────────────────────────────────────────────────┤
  │      (receives tx hash)        │                           │
  │  (4) Authorization: Payment    │                           │
  │      (type="hash", hash=0x...) │                           │
  ├──────────────────────────────>│                           │
  │                                │  getTransactionByHash     │
  │                                ├──────────────────────────>│
  │                                │  Verify transfer params   │
  │                                │<──────────────────────────┤
  │  (5) 200 OK + Receipt          │                           │
  │<───────────────────────────────┤                           │
```

---

## 9. Session Flow — Step by Step

Sessions enable **metered/streaming payments** where a client pre-deposits into a channel and the server deducts per-request without a new on-chain transaction each time.

### Conceptual Flow

```
1. Client opens a channel:
   - Call aptos_mpp::channel::open_channel(...)
   - Deposit funds (e.g., 10 USDC) → on-chain tx
   - Receive channel_id (from on-chain event)

2. Per-request (off-chain voucher):
   - Server returns 402 with session challenge
   - Client signs a monotonically increasing voucher:
     { channelId, cumulativeAmount, nonce, expiry, signature }
   - Server validates voucher signature and deducts from tracked balance
   - NO on-chain transaction per request

3. Topup:
   - When balance runs low, client sends a new deposit tx
   - Channel balance updates on-chain

4. Close:
   - Either party can close the channel
   - Final voucher is settled on-chain
   - Remaining balance returned to client
```

### Session Channel Move Module

See `move/aptos_channel/sources/channel.move` for the full implementation. Key entry functions:

```move
/// Call once after deployment — creates the escrow resource account.
public entry fun initialize(deployer)

/// Open a channel; deposits go to a deterministic resource account (escrow).
public entry fun open_channel(sender, recipient, asset_metadata, deposit_amount, expiry_timestamp, client_public_key)

/// Add more funds to an existing open channel.
public entry fun topup_channel(sender, channel_id, asset_metadata, additional_amount)

/// Settle with the highest accepted voucher; escrow pays recipient + refunds surplus to client.
public entry fun close_channel(recipient, channel_id, asset_metadata, cumulative_amount, nonce, expiry, client_signature)

/// Anyone may call after expiry_timestamp; escrow refunds remaining balance to client.
public entry fun expire_channel(channel_id)
```

**Escrow model:** `initialize` uses `account::create_resource_account` to derive a deterministic escrow account. All deposits flow into that account. `close_channel` and `expire_channel` use the stored `SignerCapability` to sign FA transfers back out — no manual key management required.

### Voucher Schema

```typescript
interface SessionVoucher {
  channelId: string;          // On-chain channel ID (hex)
  cumulativeAmount: string;   // Total consumed so far (base units, monotonic)
  nonce: number;              // Monotonically increasing integer
  expiry: number;             // Unix timestamp — voucher validity window
  signature: string;          // Ed25519 signature over the above fields (hex, no 0x)
}
```

Signature message: `SHA3-256(channelId_le64 || cumulativeAmount_le64 || nonce_le64 || expiry_le64)` — all fields little-endian u64 before hashing. This matches what the Move `close_channel` function verifies on-chain.

---

## 10. Fee Sponsorship

Fee sponsorship in Aptos uses the **Fee Payer Transaction** format (AIP-39).

### How it works

1. Server returns `feePayerAddress` and `feePayerPublicKey` in the challenge `methodDetails`.
2. Client constructs the transaction with `withFeePayer: true` (SDK sets `fee_payer_address = AccountAddress.ZERO`).
3. Client signs: produces `senderAuthenticator`.
4. Client sends JSON envelope `{ rawTransaction, senderAuthenticator }` to server.
5. Server:
   - Deserializes both.
   - Signs the transaction with fee payer key: produces `feePayerAuthenticator`.
   - Calls `aptos.transaction.submit.simple({ transaction, senderAuthenticator, feePayerAuthenticator })`.
   - Broadcasts to Aptos node.

### Client-side (TypeScript SDK)

```typescript
import { Aptos, AptosConfig, Network, Account, Ed25519PrivateKey } from "@aptos-labs/ts-sdk";

const transaction = await aptos.transaction.build.simple({
  sender: clientAccount.accountAddress,
  withFeePayer: true,   // fee_payer_address = AccountAddress.ZERO
  data: {
    function: "0x1::primary_fungible_store::transfer",
    typeArguments: [],
    functionArguments: [assetMetadataAddress, recipientAddress, amount],
  },
});

const senderAuth = aptos.transaction.sign({ signer: clientAccount, transaction });
```

### Server-side (TypeScript SDK)

```typescript
const feePayerAuth = aptos.transaction.signAsFeePayer({
  signer: feePayerAccount,
  transaction,
});

const pending = await aptos.transaction.submit.simple({
  transaction,
  senderAuthenticator: senderAuth,
  feePayerAuthenticator: feePayerAuth,
});
```

---

## 11. Replay Protection

Aptos has two natural replay-protection mechanisms that the SDK leverages:

### Sequence Number

Every Aptos account has a `sequence_number` that increments on every successful transaction. The server must:

- Return the correct `sequenceNumber` in the challenge.
- Lock it per-sender with a short TTL (matching `expirationTimestampSecs`) via `InMemoryStore.lockSequenceNumber`.
- Verify the submitted transaction uses exactly that sequence number.

### Transaction Expiry

Every Aptos transaction has `expiration_timestamp_secs`. The server sets this in the challenge; the client must use it within ±5 seconds tolerance.

### Idempotency Store

The server maintains a store keyed by challenge `id` (UUID). Once settled, the challenge ID is marked used. Subsequent attempts throw `payment_already_processed`. Use `InMemoryStore` for dev, or implement `IdempotencyStore` against Redis for production.

---

## 12. Verification Procedure

### Pull Mode Verification

1. **Decode** the BCS transaction bytes and authenticator from the envelope.
2. **Verify structure:** `sender`, `sequence_number`, `expiration_timestamp_secs`, `chain_id`.
3. **Check idempotency store** — reject if challenge ID already used.
4. **Simulate** the transaction on the Aptos node — surfaces insufficient balance, wrong sequence, etc.
5. If all checks pass → proceed to settlement.

### Push Mode Verification

1. **Fetch transaction** from Aptos node by hash.
2. **Confirm transaction success** (`success: true`).
3. **Verify sender** matches the client address from the challenge record.
4. **Check idempotency** — hash must not have been used before.

---

## 13. Settlement Procedure

### Pull Mode Settlement

1. Server adds fee payer signature (see §10).
2. Server submits `SignedTransaction` to the Aptos node.
3. Server calls `aptos.waitForTransaction({ transactionHash })` with a 30-second timeout.
4. Confirmation threshold: **1 block** (Aptos has instant finality; committed = final).
5. Server returns `200 OK` with `Payment-Receipt` header.

### Payment-Receipt Header

```
Payment-Receipt: method="aptos",
  hash="0xabcdef...",
  network="mainnet",
  amount="1000000",
  currency="USDC",
  id="<challenge-uuid>"
```

---

## 14. Error Handling

All payment failures return `402 Payment Required` with a JSON body:

```typescript
interface PaymentError {
  error: PaymentErrorCode;
  message: string;
  retryable: boolean;
}

type PaymentErrorCode =
  | "payment_required"
  | "payment_verification_failed"
  | "payment_expired"
  | "payment_already_processed"
  | "payment_simulation_failed"
  | "payment_timeout"
  | "payment_method_unsupported"
  | "payment_invalid_sequence"
  | "internal_error";
```

---

## 15. Security Considerations

### Transport Security

All communication MUST be over TLS (HTTPS) in production. HTTP is acceptable only for local development.

### Fee Payer Key Security

The fee payer private key must be stored in a secrets manager (AWS Secrets Manager, Vault, etc.). Use a dedicated key with only enough APT for operational gas.

### Sequence Number Race Conditions

For high-concurrency deployments, replace `InMemoryStore` with a Redis-backed store using `SETNX` with TTL for atomic sequence number locking.

### Simulation Before Broadcast

The server MUST simulate before broadcasting in pull mode. A failed transaction on Aptos consumes gas from the fee payer. Always simulate first to catch insufficient balance and wrong sequence number.

### Amount Verification

The server verifies the on-chain transfer amount matches the challenge exactly. Clients submitting transactions for smaller amounts are rejected at verification time, not after broadcast.

---

## 16. Repository Structure

```
aptosmpp/
├── src/
│   ├── index.ts
│   ├── Methods.ts
│   ├── constants.ts
│   ├── server/
│   │   ├── Charge.ts
│   │   ├── Session.ts
│   │   ├── Store.ts
│   │   └── index.ts
│   ├── client/
│   │   ├── Charge.ts
│   │   ├── Session.ts
│   │   └── index.ts
│   └── session/
│       ├── Types.ts
│       ├── Voucher.ts
│       ├── ChannelStore.ts
│       └── authorizers/
│           ├── Unbounded.ts
│           ├── RegularBudget.ts
│           └── index.ts
├── move/
│   └── aptos_channel/
│       ├── Move.toml
│       └── sources/channel.move
├── tests/
│   ├── unit/
│   │   ├── charge.test.ts
│   │   ├── voucher.test.ts
│   │   └── verification.test.ts
│   └── integration/
│       ├── charge-pull.test.ts
│       └── charge-push.test.ts
├── demo/
│   ├── server/index.ts
│   └── client/app.tsx
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── .env.example
```

---

## 17. Package API

### Server

```typescript
import { MppxServer, aptos } from '@aptos/mpp/server';

const mppx = MppxServer.create({
  feePayerPrivateKey: process.env.FEE_PAYER_KEY,
  methods: [
    aptos.charge({
      network: 'mainnet',
      recipient: '0xYourReceivingAddress...',
      assetAddress: '0xbae207659db88bea0cbead6da0c58b8b7a695f65ef13cf2f9de3e61d83d05a7b',
      tokenStandard: 'fa',
      decimals: 6,
    }),
  ],
});

// In your Express route handler:
app.get('/paid', async (req, res) => {
  const result = await mppx.charge({
    amount: '1000000',
    currency: 'USDC',
    externalId: crypto.randomUUID(),
  })(req.headers);

  if (result.status === 402) {
    return res.status(402).set(result.headers).json(result.body);
  }

  res.setHeader('Payment-Receipt', result.receiptHeader);
  res.json({ data: 'your payload' });
});
```

### Client

```typescript
import { MppxClient, aptos } from '@aptos/mpp/client';
import { Ed25519PrivateKey, Account } from '@aptos-labs/ts-sdk';

const account = Account.fromPrivateKey({
  privateKey: new Ed25519PrivateKey(process.env.PRIVATE_KEY),
});

const mppx = MppxClient.create({
  methods: [aptos.charge({ signer: account })],
});

// Automatically handles 402 challenge/response:
const response = await mppx.fetch('https://api.example.com/paid-endpoint');
const data = await response.json();
```

### Session (Server)

```typescript
import { MppxSessionServer } from '@aptos/mpp/server';

const server = MppxSessionServer.create({
  methods: [{
    network: 'mainnet',
    recipient: '0xYourAddress...',
    assetAddress: '0xbae20...',
    tokenStandard: 'fa',
    decimals: 6,
    channelModuleAddress: '0xYourChannelModuleAddress',
    pricing: { unit: 'request', amountPerUnit: '10000' },
    sessionDefaults: { suggestedDeposit: '10000000', ttlSeconds: 3600 },
  }],
});
```

### Session (Client)

```typescript
import { MppxSessionClient, aptosSession } from '@aptos/mpp/client';
import { UnboundedAuthorizer } from '@aptos/mpp';

const client = MppxSessionClient.create({
  methods: [{
    signer: account,
    authorizer: new UnboundedAuthorizer(account),
    buildOpenChannelTx: async (params) => { /* submit open_channel tx, return hash */ },
    buildTopupTx: async (params) => { /* submit topup_channel tx, return hash */ },
  }],
});

const response = await client.fetch('https://api.example.com/metered');
```

---

## 18. Testing — End to End

This section walks through the complete test setup from zero. All commands assume you are in the `aptosmpp/` directory.

### Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | ≥ 18 | https://nodejs.org |
| npm or pnpm | any | bundled with Node |
| Aptos CLI | ≥ 4.x | `curl -fsSL "https://aptos.dev/scripts/install_cli.py" \| python3` |

### Step 1 — Install dependencies

```bash
npm install
```

### Step 2 — Run unit tests (no network required)

Unit tests cover schema validation, BCS encoding round-trips, voucher signing/verification, store behaviour, and authorizer logic. They require no Aptos node.

```bash
npm test
```

Expected output: all tests in `tests/unit/` pass.

### Step 3 — Create two Aptos testnet accounts

The integration tests need a **server** account (receives payments) and a **client** account (pays). Both must have testnet APT for gas.

```bash
# Create server account
aptos init --profile server --network testnet
# When prompted: press enter to generate a new key

# Create client account
aptos init --profile client --network testnet

# Optional: create a separate fee-payer account for gas sponsorship
aptos init --profile feepayer --network testnet
```

This creates `~/.aptos/config.yaml` with the three profiles.

### Step 4 — Fund accounts with testnet APT

```bash
aptos account fund-with-faucet --profile server --amount 100000000
aptos account fund-with-faucet --profile client --amount 100000000
aptos account fund-with-faucet --profile feepayer --amount 100000000
```

Verify:

```bash
aptos account list --profile client
# Look for "coin": { "value": "100000000" }
```

### Step 5 — Get account private keys

```bash
# The private key is stored in ~/.aptos/config.yaml
cat ~/.aptos/config.yaml
```

Alternatively, export programmatically:

```bash
aptos account show-private-key --profile client
aptos account show-private-key --profile server
aptos account show-private-key --profile feepayer
```

### Step 6 — Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```
CLIENT_PRIVATE_KEY=0x<client-private-key-from-step-5>
SERVER_PRIVATE_KEY=0x<server-private-key-from-step-5>
FEE_PAYER_PRIVATE_KEY=0x<feepayer-private-key-from-step-5>  # optional
APTOS_NETWORK=testnet
TOKEN_STANDARD=coin
TOKEN_DECIMALS=8
CURRENCY=APT
CHARGE_AMOUNT=100
PORT=3000
```

> **Note:** Using APT (coin standard) for integration tests is simplest because
> testnet APT is freely available from the faucet. For USDC, source testnet USDC
> separately and set `TOKEN_STANDARD=fa` with the correct `ASSET_ADDRESS`.

### Step 7 — Run integration tests

Integration tests hit the real Aptos testnet and execute on-chain transactions. They are skipped automatically when `CLIENT_PRIVATE_KEY` / `SERVER_PRIVATE_KEY` are not set.

```bash
# Load .env and run
source .env && npm run test:integration
```

Or inline:

```bash
CLIENT_PRIVATE_KEY=0x... \
SERVER_PRIVATE_KEY=0x... \
FEE_PAYER_PRIVATE_KEY=0x... \
npm run test:integration
```

The tests:
1. Issue a 402 challenge (fetches client sequence number from testnet).
2. Client builds and signs a transaction (coin transfer of 100 octas).
3. Server simulates, co-signs as fee payer, and broadcasts.
4. Server polls until confirmed.
5. Verifies replay protection (second attempt throws `payment_already_processed`).
6. Repeats for push mode (client broadcasts, server verifies hash).

Each test takes 5–15 seconds depending on testnet latency.

### Step 8 — Run the demo

In one terminal start the server:

```bash
source .env && npm run demo:server
# Server listening on http://localhost:3000
```

In another terminal run the client demo:

```bash
source .env && CLIENT_PRIVATE_KEY=0x... npx tsx demo/client/app.tsx
```

Expected output:

```
Client address: 0x<client-address>

[Health] { ok: true, server: '0x...', network: 'testnet', chargeAmount: '100', currency: 'APT' }

── Pull mode (server broadcasts) ──
Status: 200
Payment-Receipt: method="aptos", hash="0x...", network="testnet", amount="100", currency="APT", id="..."
Body: { message: 'Hello from the paid endpoint (pull mode)!', timestamp: '...', data: { answer: 42 } }

── Push mode (client broadcasts) ──
Status: 200
Payment-Receipt: method="aptos", hash="0x...", network="testnet", amount="100", currency="APT", id="..."
Body: { message: 'Hello from the paid endpoint (push mode)!', timestamp: '...', data: { answer: 42 } }
```

### Step 9 — Compile, deploy, and initialize the Move contract (session support)

```bash
cd move/aptos_channel

# Compile (replace with your server account address)
aptos move compile --named-addresses aptos_mpp=<server-account-address>

# Publish to testnet
aptos move publish \
  --profile server \
  --named-addresses aptos_mpp=<server-account-address>

# Initialize: creates the escrow resource account (call once per deployment)
aptos move run \
  --profile server \
  --function-id '<server-account-address>::channel::initialize'

# Verify the escrow address was set
aptos move view \
  --function-id '<server-account-address>::channel::get_escrow_address'
```

After deployment, set the module address in your `.env`:

```
MODULE_ADDRESS=0x<server-account-address>
```

### Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| `SEQUENCE_NUMBER_TOO_OLD` | Pending tx from a previous test | Wait 30s for expiry, then retry |
| `INSUFFICIENT_BALANCE` | Client account ran out of APT | Re-run `aptos account fund-with-faucet` |
| `Tests skip silently` | `CLIENT_PRIVATE_KEY` not set | Ensure `source .env` was run before `npm run test:integration` |
| `Simulation failed` | Wrong asset address or token standard | Double-check `TOKEN_STANDARD` and `ASSET_ADDRESS` in `.env` |
| `Connection refused on demo` | Server not running | Start `npm run demo:server` first |

---

## 19. Implementation Checklist

### Phase 1 — Charge (Pull Mode) ✅

- [x] Zod schemas: `ChargeRequest`, `AptosMethodDetails`, `AptosTransactionPayload`
- [x] `server/Charge.ts`: `issueChallenge()` — fetch sequence number, build `WWW-Authenticate`
- [x] `server/Charge.ts`: `verifyAndSettle()` — decode BCS, verify structure + sig
- [x] `server/Charge.ts`: `simulate()` — dry run via Aptos SDK
- [x] `server/Charge.ts`: `settle()` — add fee payer sig, broadcast, poll confirmation
- [x] `client/Charge.ts`: `fulfillChallenge()` — parse request, build FA or coin transfer tx
- [x] `client/Charge.ts`: fee payer transaction support (`withFeePayer: true`)
- [x] `client/Charge.ts`: `fetch()` — automatic 402 retry wrapper
- [x] `constants.ts`: USDC FA address, APT coin type, node URLs per network
- [x] `server/Store.ts`: in-memory idempotency + sequence lock store
- [x] Unit tests: schema validation, store behaviour, encoding round-trips
- [ ] Integration tests: full pull mode charge on testnet *(requires funded accounts)*

### Phase 2 — Charge (Push Mode) ✅

- [x] `client/Charge.ts`: push mode — sign + broadcast, return hash
- [x] `server/Charge.ts`: push mode verification — fetch tx by hash, verify params
- [ ] Integration tests: push mode on testnet *(requires funded accounts)*

### Phase 3 — Fee Sponsorship ✅

- [x] Server: fee payer key management + co-signing
- [x] Client: `withFeePayer: true` transaction build path
- [ ] Tests: sponsored vs. non-sponsored charge flows on testnet

### Phase 4 — Sessions (partial)

- [x] Write `move/aptos_channel/` Move module — fully implemented, compiles clean (zero warnings)
- [x] Resource account escrow pattern — `close_channel` and `expire_channel` transfer from escrow
- [ ] Deploy to testnet, call `initialize`, record module address
- [x] `session/Voucher.ts`: Ed25519 voucher signing + verification
- [x] `session/ChannelStore.ts`: persistent channel state (pluggable)
- [x] `session/authorizers/`: Unbounded, RegularBudget
- [x] `server/Session.ts`: challenge, deduct balance, manage channel lifecycle
- [x] `client/Session.ts`: open channel, sign vouchers, auto-topup
- [ ] Integration tests: full session lifecycle on testnet

### Phase 5 — Production Hardening

- [ ] Redis adapter for `IdempotencyStore`
- [ ] Redis adapter for `ChannelStore`
- [ ] Key rotation for fee payer account
- [ ] OpenTelemetry instrumentation

---

## 20. References

| Resource | URL |
|---|---|
| HTTP Payment Authentication Scheme (core spec) | https://paymentauth.org/draft-httpauth-payment-00.html |
| Charge Intent Spec | https://paymentauth.org/draft-payment-intent-charge-00.html |
| MPP Specs Repo | https://github.com/tempoxyz/mpp-specs |
| Aptos TypeScript SDK | https://aptos.dev/sdks/ts-sdk |
| Aptos Move Reference | https://aptos.dev/move/move-on-aptos |
| AIP-39 (Fee Payer Transactions) | https://github.com/aptos-foundation/AIPs/blob/main/aips/aip-39.md |
| Aptos Fungible Asset Standard | https://aptos.dev/standards/fungible-asset |
| Circle USDC on Aptos | https://developers.circle.com/stablecoins/usdc-on-aptos |
| mppx (protocol middleware) | https://www.npmjs.com/package/mppx |
