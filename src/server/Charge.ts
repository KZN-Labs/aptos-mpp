import {
  Aptos,
  AptosConfig,
  Network,
  Account,
  Ed25519PrivateKey,
  AccountAddress,
  AccountAuthenticator,
  SimpleTransaction,
  Deserializer,
} from "@aptos-labs/ts-sdk";
import {
  ChargeRequest,
  PaymentCredential,
  PaymentCredentialSchema,
  AptosTransactionPayload,
  AptosHashPayload,
} from "../protocol.js";
import {
  APTOS_NETWORKS,
  PAYMENT_METHOD,
  PAYMENT_INTENT_CHARGE,
  DEFAULT_EXPIRY_SECONDS,
  SEQUENCE_LOCK_TTL_SECONDS,
  CONFIRMATION_TIMEOUT_MS,
  CHALLENGE_STORE_TTL_SECONDS,
} from "../constants.js";
import { InMemoryStore, IdempotencyStore, ChallengeRecord } from "./Store.js";

// ── Errors ────────────────────────────────────────────────────────────────

export type PaymentErrorCode =
  | "payment_required"
  | "payment_verification_failed"
  | "payment_expired"
  | "payment_already_processed"
  | "payment_timeout"
  | "payment_method_unsupported"
  | "payment_invalid_sequence"
  | "internal_error";

export class PaymentError extends Error {
  constructor(
    public readonly code: PaymentErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "PaymentError";
  }

  toJSON() {
    return { error: this.code, message: this.message, retryable: this.retryable };
  }
}

// ── Config ────────────────────────────────────────────────────────────────

export interface ServerChargeMethodConfig {
  network: "mainnet" | "testnet" | "devnet" | "localnet";
  recipient: string;
  assetAddress?: string;
  tokenStandard?: "coin" | "fa";
  decimals: number;
}

export interface MppxServerConfig {
  /** HMAC secret for optional challenge signing (currently informational) */
  secretKey?: string;
  /** Private key of the gas-sponsoring fee-payer account */
  feePayerPrivateKey?: string;
  methods: ServerChargeMethodConfig[];
  store?: IdempotencyStore;
}

// ── Internal transaction envelope (the `transaction` field in credential) ──

interface TxEnvelope {
  rawTransaction: string;       // hex-encoded BCS SimpleTransaction
  senderAuthenticator: string;  // hex-encoded BCS AccountAuthenticator
}

function parseTxEnvelope(raw: string): TxEnvelope {
  try {
    const parsed = JSON.parse(raw) as TxEnvelope;
    if (typeof parsed.rawTransaction !== "string" || typeof parsed.senderAuthenticator !== "string") {
      throw new Error("missing fields");
    }
    return parsed;
  } catch {
    throw new PaymentError(
      "payment_verification_failed",
      "Malformed transaction envelope in credential",
    );
  }
}

// ── Receipt ───────────────────────────────────────────────────────────────

export interface SettlementReceipt {
  txHash: string;
  network: string;
  amount: string;
  currency: string;
  challengeId: string;
}

function formatReceiptHeader(r: SettlementReceipt): string {
  return (
    `method="aptos", ` +
    `hash="${r.txHash}", ` +
    `network="${r.network}", ` +
    `amount="${r.amount}", ` +
    `currency="${r.currency}", ` +
    `id="${r.challengeId}"`
  );
}

// ── Mppx Server ───────────────────────────────────────────────────────────

export class MppxServer {
  private readonly config: MppxServerConfig;
  private readonly store: IdempotencyStore;
  private readonly clients: Map<string, Aptos> = new Map();
  private readonly feePayerAccount?: Account;
  private readonly method: ServerChargeMethodConfig;
  private cachedChainId?: number;

  constructor(config: MppxServerConfig) {
    this.config = config;
    this.store = config.store ?? new InMemoryStore();
    this.method = config.methods[0]; // currently single-method

    const aptosNetwork = APTOS_NETWORKS[this.method.network] ?? Network.TESTNET;
    const aptosConfig = new AptosConfig({ network: aptosNetwork });
    this.clients.set(this.method.network, new Aptos(aptosConfig));

    if (config.feePayerPrivateKey) {
      const pk = new Ed25519PrivateKey(config.feePayerPrivateKey);
      this.feePayerAccount = Account.fromPrivateKey({ privateKey: pk });
    }
  }

  static create(config: MppxServerConfig): MppxServer {
    return new MppxServer(config);
  }

  private get aptos(): Aptos {
    return this.clients.get(this.method.network)!;
  }

  private async getChainId(): Promise<number> {
    if (this.cachedChainId !== undefined) return this.cachedChainId;
    const info = await this.aptos.getLedgerInfo();
    this.cachedChainId = Number(info.chain_id);
    return this.cachedChainId;
  }

  // ── Challenge issuance ─────────────────────────────────────────────────

  /**
   * Build and return a Payment 402 challenge response.
   *
   * Pass `senderAddress` when you know the client's Aptos address (e.g. from
   * an `X-Aptos-Sender` header). The server will fetch the current sequence
   * number and include it in the challenge so the client doesn't have to.
   * Without `senderAddress`, the challenge omits the sequence number and the
   * client must fetch it themselves.
   */
  async issueChallenge(params: {
    amount: string;
    currency: string;
    description?: string;
    externalId?: string;
    senderAddress?: string;
  }): Promise<{
    challengeId: string;
    status: 402;
    headers: Record<string, string>;
    body: object;
  }> {
    const { v4: uuidv4 } = await import("uuid");
    const challengeId = uuidv4();
    const expirationTimestampSecs =
      Math.floor(Date.now() / 1000) + DEFAULT_EXPIRY_SECONDS;

    let sequenceNumber: string | undefined;

    if (params.senderAddress) {
      try {
        const info = await this.aptos.getAccountInfo({
          accountAddress: AccountAddress.from(params.senderAddress),
        });
        sequenceNumber = String(info.sequence_number);

        // Reserve this sequence number so concurrent challenges don't collide
        const locked = await this.store.lockSequenceNumber(
          params.senderAddress,
          challengeId,
          SEQUENCE_LOCK_TTL_SECONDS,
        );
        if (!locked) {
          throw new PaymentError(
            "payment_invalid_sequence",
            "A pending challenge is already using this sender's sequence number. Retry shortly.",
            true,
          );
        }
      } catch (err) {
        if (err instanceof PaymentError) throw err;
        // If we can't fetch the account (new account, etc.) just omit seqno
      }
    }

    const request: ChargeRequest = {
      amount: params.amount,
      currency: params.currency,
      recipient: this.method.recipient,
      description: params.description,
      externalId: params.externalId,
      methodDetails: {
        network: this.method.network,
        assetAddress: this.method.assetAddress,
        tokenStandard: this.method.tokenStandard,
        decimals: this.method.decimals,
        sequenceNumber,
        expirationTimestampSecs,
        feePayerAddress: this.feePayerAccount
          ? this.feePayerAccount.accountAddress.toString()
          : undefined,
        feePayerPublicKey: this.feePayerAccount
          ? this.feePayerAccount.publicKey.toString().replace("0x", "")
          : undefined,
        acceptedTypes: ["transaction", "hash"],
      },
    };

    const requestEncoded = Buffer.from(JSON.stringify(request)).toString("base64url");

    const record: ChallengeRecord = {
      challengeId,
      amount: params.amount,
      currency: params.currency,
      recipient: this.method.recipient,
      senderAddress: params.senderAddress,
      sequenceNumber,
      expirationTimestampSecs,
      createdAt: Date.now(),
    };
    await this.store.storeChallenge(
      challengeId,
      record,
      CHALLENGE_STORE_TTL_SECONDS,
    );

    return {
      challengeId,
      status: 402,
      headers: {
        "WWW-Authenticate": `Payment id="${challengeId}", method="${PAYMENT_METHOD}", intent="${PAYMENT_INTENT_CHARGE}", request="${requestEncoded}"`,
        "Content-Type": "application/json",
      },
      body: {
        error: "payment_required",
        message: "Payment required to access this resource.",
        retryable: false,
      },
    };
  }

  // ── Credential verification ────────────────────────────────────────────

  /**
   * Parse and verify a credential from an `Authorization: Payment <b64url>` header.
   * On success returns the settlement receipt. On failure throws PaymentError.
   */
  async verifyAndSettle(authHeader: string): Promise<SettlementReceipt> {
    if (!authHeader.startsWith("Payment ")) {
      throw new PaymentError(
        "payment_verification_failed",
        "Authorization header must use Payment scheme",
      );
    }

    const encoded = authHeader.slice("Payment ".length).trim();
    let credential: PaymentCredential;
    try {
      const raw = JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8"));
      credential = PaymentCredentialSchema.parse(raw);
    } catch {
      throw new PaymentError(
        "payment_verification_failed",
        "Could not parse payment credential",
      );
    }

    // Load the original challenge
    const record = await this.store.getChallenge(credential.id);
    if (!record) {
      throw new PaymentError(
        "payment_expired",
        "Challenge not found or expired",
      );
    }

    // Guard against replay
    const alreadyUsed = await this.store.isUsed(credential.id);
    if (alreadyUsed) {
      throw new PaymentError(
        "payment_already_processed",
        "This challenge has already been settled",
      );
    }

    // Check challenge expiry
    if (
      record.expirationTimestampSecs &&
      Math.floor(Date.now() / 1000) > record.expirationTimestampSecs
    ) {
      throw new PaymentError("payment_expired", "Challenge has expired", true);
    }

    let txHash: string;

    try {
      if (credential.payload.type === "transaction") {
        txHash = await this.settlePullMode(
          credential.payload as AptosTransactionPayload,
          record,
          credential.id,
        );
      } else {
        txHash = await this.settlePushMode(
          credential.payload as AptosHashPayload,
          record,
          credential.id,
        );
      }
    } catch (err) {
      // Always release the sequence lock on failure so the client can retry
      if (record.senderAddress) {
        await this.store.unlockSequenceNumber(record.senderAddress);
      }
      throw err;
    }

    // Mark as used only after successful settlement
    await this.store.markUsed(credential.id, CHALLENGE_STORE_TTL_SECONDS);
    if (record.senderAddress) {
      await this.store.unlockSequenceNumber(record.senderAddress);
    }

    return {
      txHash,
      network: this.method.network,
      amount: record.amount,
      currency: record.currency,
      challengeId: credential.id,
    };
  }

  // ── Pull mode settlement ───────────────────────────────────────────────

  private async settlePullMode(
    payload: AptosTransactionPayload,
    record: ChallengeRecord,
    challengeId: string,
  ): Promise<string> {
    const envelope = parseTxEnvelope(payload.transaction);

    // Deserialize raw transaction
    let transaction: SimpleTransaction;
    try {
      const rawBytes = Buffer.from(envelope.rawTransaction, "hex");
      const des = new Deserializer(rawBytes);
      transaction = SimpleTransaction.deserialize(des);
    } catch {
      throw new PaymentError(
        "payment_verification_failed",
        "Could not deserialize raw transaction",
      );
    }

    // Deserialize sender authenticator
    let senderAuth: AccountAuthenticator;
    try {
      const authBytes = Buffer.from(envelope.senderAuthenticator, "hex");
      const des = new Deserializer(authBytes);
      senderAuth = AccountAuthenticator.deserialize(des);
    } catch {
      throw new PaymentError(
        "payment_verification_failed",
        "Could not deserialize sender authenticator",
      );
    }

    // Structural checks
    await this.verifyTransactionStructure(transaction, record);

    // Co-sign as fee payer if configured
    let feePayerAuth: AccountAuthenticator | undefined;
    if (this.feePayerAccount) {
      feePayerAuth = this.aptos.transaction.signAsFeePayer({
        signer: this.feePayerAccount,
        transaction,
      });
    }

    // Submit
    const pending = await this.aptos.transaction.submit.simple({
      transaction,
      senderAuthenticator: senderAuth,
      feePayerAuthenticator: feePayerAuth,
    });

    // Wait for confirmation with timeout
    return this.waitForConfirmation(pending.hash);
  }

  // ── Push mode settlement ───────────────────────────────────────────────

  private async settlePushMode(
    payload: AptosHashPayload,
    record: ChallengeRecord,
    challengeId: string,
  ): Promise<string> {
    let txn: Awaited<ReturnType<Aptos["getTransactionByHash"]>>;
    try {
      txn = await this.aptos.getTransactionByHash({
        transactionHash: payload.hash,
      });
    } catch {
      throw new PaymentError(
        "payment_verification_failed",
        `Transaction ${payload.hash} not found on-chain`,
      );
    }

    if (txn.type !== "user_transaction") {
      throw new PaymentError(
        "payment_verification_failed",
        "Transaction is not a user transaction",
      );
    }

    const userTxn = txn as {
      success: boolean;
      sender: string;
      payload: { function?: string; arguments?: unknown[] };
    };

    if (!userTxn.success) {
      throw new PaymentError(
        "payment_verification_failed",
        "On-chain transaction did not succeed",
      );
    }

    // Verify sender matches (if we know who it should be)
    if (
      record.senderAddress &&
      userTxn.sender.toLowerCase() !== record.senderAddress.toLowerCase()
    ) {
      throw new PaymentError(
        "payment_verification_failed",
        "Transaction sender does not match challenge originator",
      );
    }

    return payload.hash;
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private async verifyTransactionStructure(
    transaction: SimpleTransaction,
    record: ChallengeRecord,
  ): Promise<void> {
    const rawTxn = transaction.rawTransaction;

    // Sequence number check
    if (
      record.sequenceNumber !== undefined &&
      rawTxn.sequence_number.toString() !== record.sequenceNumber
    ) {
      throw new PaymentError(
        "payment_invalid_sequence",
        `Sequence number mismatch: expected ${record.sequenceNumber}, got ${rawTxn.sequence_number}`,
      );
    }

    // Expiry check
    if (record.expirationTimestampSecs !== undefined) {
      const txExpiry = Number(rawTxn.expiration_timestamp_secs);
      const delta = Math.abs(txExpiry - record.expirationTimestampSecs);
      if (delta > 5) {
        throw new PaymentError(
          "payment_verification_failed",
          `Transaction expiry ${txExpiry} deviates more than 5s from challenge expiry ${record.expirationTimestampSecs}`,
        );
      }
    }

    // Chain ID check — fetch live from the node so devnet resets never break this
    const expectedChainId = await this.getChainId();
    if (Number(rawTxn.chain_id) !== expectedChainId) {
      throw new PaymentError(
        "payment_verification_failed",
        `Wrong chain_id: expected ${expectedChainId}, got ${rawTxn.chain_id}`,
      );
    }
  }

  private async waitForConfirmation(hash: string): Promise<string> {
    const deadline = Date.now() + CONFIRMATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const result = await this.aptos.waitForTransaction({
          transactionHash: hash,
          options: { timeoutSecs: 5 },
        });
        if (result.success) return hash;
        throw new PaymentError(
          "payment_verification_failed",
          `Transaction ${hash} failed on-chain: ${result.vm_status}`,
        );
      } catch (err) {
        if (err instanceof PaymentError) throw err;
        // Timeout from waitForTransaction — loop and retry
      }
    }
    throw new PaymentError(
      "payment_timeout",
      `Transaction ${hash} was not confirmed within ${CONFIRMATION_TIMEOUT_MS / 1000}s`,
      true,
    );
  }

  // ── Middleware factory (framework-agnostic) ────────────────────────────

  /**
   * Returns a middleware-style function.
   *
   * Usage (Express):
   * ```ts
   * app.get('/paid', async (req, res) => {
   *   const result = await mppx.charge({ amount: '1000000', currency: 'APT' })(req.headers);
   *   if (result.status === 402) {
   *     return res.status(402).set(result.headers).json(result.body);
   *   }
   *   res.set('Payment-Receipt', result.receiptHeader).json({ ok: true });
   * });
   * ```
   */
  charge(params: {
    amount: string;
    currency: string;
    description?: string;
    externalId?: string;
  }) {
    return async (
      headers: Record<string, string | string[] | undefined>,
    ): Promise<
      | { status: 402; headers: Record<string, string>; body: object; challengeId: string }
      | { status: "settled"; receipt: SettlementReceipt; receiptHeader: string }
    > => {
      const authHeader =
        typeof headers["authorization"] === "string"
          ? headers["authorization"]
          : Array.isArray(headers["authorization"])
            ? headers["authorization"][0]
            : undefined;

      const senderAddress =
        typeof headers["x-aptos-sender"] === "string"
          ? headers["x-aptos-sender"]
          : undefined;

      if (!authHeader?.startsWith("Payment ")) {
        const challenge = await this.issueChallenge({ ...params, senderAddress });
        return challenge;
      }

      const receipt = await this.verifyAndSettle(authHeader);
      return {
        status: "settled",
        receipt,
        receiptHeader: formatReceiptHeader(receipt),
      };
    };
  }
}

// ── Convenience builder ────────────────────────────────────────────────────

export const aptos = {
  charge: (opts: ServerChargeMethodConfig): ServerChargeMethodConfig => opts,
};
