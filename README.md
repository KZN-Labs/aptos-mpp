# `aptosmpp` — Aptos Payment Method for the Machine Payments Protocol

> Aptos adapter for [MPP](https://mpp.dev) — the open protocol by Tempo + Stripe that lets any HTTP API accept crypto payments from AI agents using HTTP 402.
> Solana has theirs. Now Aptos does too.

---

## Install

```bash
npm install aptosmpp
```

---

## What it does

Any HTTP API can require payment before serving a response — no signup, no credit card, no subscription. The client (an AI agent or wallet) pays per request in APT or USDC. The server verifies on-chain and returns the resource.

Two modes:

- **Charge** — one payment per request, settled on-chain immediately
- **Session** — client deposits once into a Move escrow contract, sends signed vouchers per request, server settles at the end. Thousands of micropayments for the cost of 2 transactions.

---

## Server

```typescript
import { MppxServer, aptos } from 'aptosmpp/server';

const mppx = MppxServer.create({
  feePayerPrivateKey: process.env.FEE_PAYER_KEY,
  methods: [
    aptos.charge({
      network: 'mainnet',
      recipient: '0xYourAddress',
      assetAddress: '0xbae207659db88bea0cbead6da0c58b8b7a695f65ef13cf2f9de3e61d83d05a7b', // USDC
      tokenStandard: 'fa',
      decimals: 6,
    }),
  ],
});

app.get('/paid', async (req, res) => {
  const result = await mppx.charge({ amount: '1000000', currency: 'USDC' })(req.headers);
  if (result.status === 402) return res.status(402).set(result.headers).json(result.body);
  res.setHeader('Payment-Receipt', result.receiptHeader);
  res.json({ data: 'your payload' });
});
```

## Client

```typescript
import { MppxClient, aptos } from 'aptosmpp/client';
import { Ed25519PrivateKey, Account } from '@aptos-labs/ts-sdk';

const account = Account.fromPrivateKey({
  privateKey: new Ed25519PrivateKey(process.env.PRIVATE_KEY),
});

const mppx = MppxClient.create({
  methods: [aptos.charge({ signer: account })],
});

// Automatically handles the 402 challenge/response
const response = await mppx.fetch('https://api.example.com/paid-endpoint');
```

---

## How it works

```
Client                          Server                    Aptos Node
  │  GET /resource                 │                           │
  ├──────────────────────────────> │                           │
  │                                │                           │
  │  402 + WWW-Authenticate        │                           │
  │ <────────────────────────────  │                           │
  │                                │                           │
  │  Authorization: Payment <tx>   │                           │
  ├──────────────────────────────> │                           │
  │                                │  simulate + broadcast     │
  │                                ├─────────────────────────> │
  │                                │ <───────────────────────  │
  │  200 OK + Payment-Receipt      │                           │
  │ <────────────────────────────  │                           │
```

**Pull mode (default):** Client signs but doesn't broadcast. Server verifies, co-signs as fee payer, broadcasts. Client pays zero gas.

**Push mode (fallback):** Client broadcasts, sends the tx hash to server. Server verifies on-chain.

---

## Payment Channels (Session Mode)

For AI agents making many calls to the same API:

```typescript
// Server
const server = MppxSessionServer.create({
  methods: [{
    network: 'mainnet',
    recipient: '0xYourAddress',
    channelModuleAddress: '0xYourDeployedContractAddress',
    pricing: { unit: 'request', amountPerUnit: '10000' },
    sessionDefaults: { suggestedDeposit: '10000000', ttlSeconds: 3600 },
  }],
});

// Client
const client = MppxSessionClient.create({
  methods: [{
    signer: account,
    authorizer: new UnboundedAuthorizer(account),
    buildOpenChannelTx: async (params) => { /* submit open_channel, return hash */ },
  }],
});
```

The client opens a channel once (deposits funds into a Move escrow), then sends signed vouchers per request with no on-chain transaction each time. The server settles the final voucher when done.

---

## Move Contract

The payment channel contract is in `move/aptos_channel/`. Deploy it once:

```bash
cd move/aptos_channel
aptos move publish --profile server --named-addresses aptos_mpp=<your-address>
aptos move run --profile server --function-id '<your-address>::channel::initialize'
```

---

## Production Storage

For multi-instance deployments, swap the default in-memory stores for Redis:

```typescript
import Redis from 'ioredis';
import { RedisStore } from 'aptosmpp/server';
import { RedisChannelStore } from 'aptosmpp';

const redis = new Redis(process.env.REDIS_URL);

MppxServer.create({ store: new RedisStore(redis), ... });
MppxSessionServer.create({ store: new RedisChannelStore(redis), ... });
```

---

## Repo Structure

```
aptosmpp/
├── src/
│   ├── server/         # MppxServer, RedisStore
│   ├── client/         # MppxClient, MppxSessionClient
│   └── session/        # Voucher signing, ChannelStore, RedisChannelStore, authorizers
├── move/
│   └── aptos_channel/  # Move smart contract (escrow + payment channels)
├── demo/               # Express server + Node client demo
└── tests/              # Unit + integration tests
```

---

## Testing

```bash
npm test                    # unit tests, no network needed
npm run test:integration    # runs against devnet, requires .env
npm run demo:server         # start demo server
npm run demo:client         # run demo client
```

---

## Spec

Implements [draft-httpauth-payment-00](https://paymentauth.org/draft-httpauth-payment-00.html) and [draft-payment-intent-charge-00](https://paymentauth.org/draft-payment-intent-charge-00.html).

Built on the [MPP spec](https://github.com/tempoxyz/mpp-specs) by Tempo + Stripe. This is an independent open-source implementation — not a Tempo product. Any Aptos wallet works as the paying client.

---

## License

Apache-2.0