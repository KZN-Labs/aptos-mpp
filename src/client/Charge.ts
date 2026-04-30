import {
  Aptos,
  AptosConfig,
  Network,
  Account,
  AccountAddress,
  SimpleTransaction,
  AccountAuthenticator,
  Serializer,
} from "@aptos-labs/ts-sdk";
import {
  ChargeRequestSchema,
  PaymentCredential,
  AptosChargePayload,
} from "../protocol.js";
import { APTOS_NETWORKS, PAYMENT_METHOD, PAYMENT_INTENT_CHARGE } from "../constants.js";

// ── Config ────────────────────────────────────────────────────────────────

export interface ClientChargeMethodConfig {
  signer: Account;
}

export interface MppxClientConfig {
  methods: ClientChargeMethodConfig[];
}

// ── Internal transaction envelope ─────────────────────────────────────────

interface TxEnvelope {
  rawTransaction: string;       // hex-encoded BCS SimpleTransaction
  senderAuthenticator: string;  // hex-encoded BCS AccountAuthenticator
}

// ── Parse WWW-Authenticate: Payment header ────────────────────────────────

function parseChallenge(wwwAuth: string): {
  challengeId: string;
  method: string;
  intent: string;
  requestRaw: string;
} {
  const idMatch = wwwAuth.match(/id="([^"]+)"/);
  const methodMatch = wwwAuth.match(/method="([^"]+)"/);
  const intentMatch = wwwAuth.match(/intent="([^"]+)"/);
  const requestMatch = wwwAuth.match(/request="([^"]+)"/);

  if (!idMatch || !methodMatch || !intentMatch || !requestMatch) {
    throw new Error("Malformed WWW-Authenticate: Payment header");
  }

  return {
    challengeId: idMatch[1],
    method: methodMatch[1],
    intent: intentMatch[1],
    requestRaw: requestMatch[1],
  };
}

// ── Build Aptos transfer transaction ──────────────────────────────────────

interface BuildTxParams {
  aptos: Aptos;
  signer: Account;
  recipientAddress: string;
  amount: bigint;
  assetAddress: string | undefined;
  tokenStandard: "coin" | "fa";
  sequenceNumber: bigint | undefined;
  expirationTimestampSecs: number;
  withFeePayer: boolean;
  feePayerAddress: string | undefined;
}

async function buildTransferTransaction(
  params: BuildTxParams,
): Promise<SimpleTransaction> {
  const {
    aptos,
    signer,
    recipientAddress,
    amount,
    assetAddress,
    tokenStandard,
    sequenceNumber,
    expirationTimestampSecs,
    withFeePayer,
  } = params;

  const options: Parameters<typeof aptos.transaction.build.simple>[0]["options"] = {
    expireTimestamp: expirationTimestampSecs,
  };
  if (sequenceNumber !== undefined) {
    options.accountSequenceNumber = sequenceNumber;
  }

  // ── Fungible Asset transfer ──────────────────────────────────────────
  if (tokenStandard === "fa" && assetAddress) {
    return aptos.transaction.build.simple({
      sender: signer.accountAddress,
      withFeePayer,
      data: {
        function: "0x1::primary_fungible_store::transfer",
        typeArguments: [],
        functionArguments: [
          AccountAddress.from(assetAddress),   // metadata object
          AccountAddress.from(recipientAddress),
          amount,
        ],
      },
      options,
    });
  }

  // ── Legacy Coin transfer ─────────────────────────────────────────────
  const coinType = assetAddress ?? "0x1::aptos_coin::AptosCoin";
  return aptos.transaction.build.simple({
    sender: signer.accountAddress,
    withFeePayer,
    data: {
      function: "0x1::coin::transfer",
      typeArguments: [coinType],
      functionArguments: [AccountAddress.from(recipientAddress), amount],
    },
    options,
  });
}

// ── Serialize transaction + authenticator to hex ──────────────────────────

function serializeTx(transaction: SimpleTransaction): string {
  const ser = new Serializer();
  transaction.serialize(ser);
  return Buffer.from(ser.toUint8Array()).toString("hex");
}

function serializeAuth(auth: AccountAuthenticator): string {
  const ser = new Serializer();
  auth.serialize(ser);
  return Buffer.from(ser.toUint8Array()).toString("hex");
}

// ── MppxClient ────────────────────────────────────────────────────────────

export class MppxClient {
  private readonly signer: Account;
  private readonly aptosClients = new Map<string, Aptos>();

  constructor(config: MppxClientConfig) {
    this.signer = config.methods[0].signer;
  }

  static create(config: MppxClientConfig): MppxClient {
    return new MppxClient(config);
  }

  private getAptos(network: string): Aptos {
    if (!this.aptosClients.has(network)) {
      const net = APTOS_NETWORKS[network] ?? Network.TESTNET;
      this.aptosClients.set(network, new Aptos(new AptosConfig({ network: net })));
    }
    return this.aptosClients.get(network)!;
  }

  /**
   * Fulfil a `WWW-Authenticate: Payment ...` 402 challenge and return an
   * `Authorization: Payment <b64url>` header value.
   *
   * @param wwwAuth - The full `WWW-Authenticate` header string from the 402.
   * @param preferHash - If true, use push mode (broadcast first, return hash).
   *                     Default is pull mode (send signed tx to server).
   */
  async fulfillChallenge(
    wwwAuth: string,
    preferHash = false,
  ): Promise<string> {
    const challenge = parseChallenge(wwwAuth);

    if (challenge.method !== PAYMENT_METHOD || challenge.intent !== PAYMENT_INTENT_CHARGE) {
      throw new Error(
        `Unsupported payment method/intent: ${challenge.method}/${challenge.intent}`,
      );
    }

    const request = ChargeRequestSchema.parse(
      JSON.parse(Buffer.from(challenge.requestRaw, "base64url").toString("utf-8")),
    );

    const md = request.methodDetails;
    const aptos = this.getAptos(md.network);

    // Resolve sequence number
    let sequenceNumber: bigint | undefined;
    if (md.sequenceNumber !== undefined) {
      sequenceNumber = BigInt(md.sequenceNumber);
    } else {
      // Fetch from chain when server didn't include it
      const info = await aptos.getAccountInfo({
        accountAddress: this.signer.accountAddress,
      });
      sequenceNumber = BigInt(info.sequence_number);
    }

    const expirationTimestampSecs =
      md.expirationTimestampSecs ?? Math.floor(Date.now() / 1000) + 120;

    const withFeePayer = !preferHash && !!md.feePayerAddress;

    // Build the transaction
    const transaction = await buildTransferTransaction({
      aptos,
      signer: this.signer,
      recipientAddress: request.recipient,
      amount: BigInt(request.amount),
      assetAddress: md.assetAddress,
      tokenStandard: md.tokenStandard ?? "coin",
      sequenceNumber,
      expirationTimestampSecs,
      withFeePayer,
      feePayerAddress: md.feePayerAddress,
    });

    let payload: AptosChargePayload;

    if (preferHash) {
      // Push mode: sign + broadcast, return hash
      const senderAuth = aptos.transaction.sign({
        signer: this.signer,
        transaction,
      });
      const pending = await aptos.transaction.submit.simple({
        transaction,
        senderAuthenticator: senderAuth,
      });
      await aptos.waitForTransaction({ transactionHash: pending.hash });
      payload = { type: "hash", hash: pending.hash };
    } else {
      // Pull mode: sign, package raw tx + auth, send to server
      const senderAuth = aptos.transaction.sign({
        signer: this.signer,
        transaction,
      });

      const envelope: TxEnvelope = {
        rawTransaction: serializeTx(transaction),
        senderAuthenticator: serializeAuth(senderAuth),
      };

      payload = {
        type: "transaction",
        transaction: JSON.stringify(envelope),
      };
    }

    const credential: PaymentCredential = {
      id: challenge.challengeId,
      method: PAYMENT_METHOD,
      intent: PAYMENT_INTENT_CHARGE,
      payload,
    };

    return `Payment ${Buffer.from(JSON.stringify(credential)).toString("base64url")}`;
  }

  /**
   * fetch() wrapper that automatically handles 402 Payment Required responses.
   *
   * On receiving a 402 the client fulfils the challenge and retries the
   * original request with an Authorization header. If the retry also fails
   * with 402 an error is thrown.
   */
  async fetch(
    url: string,
    init: RequestInit = {},
    preferHash = false,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    // Advertise our sender address so the server can fetch our sequence number
    headers.set("X-Aptos-Sender", this.signer.accountAddress.toString());

    const response = await globalThis.fetch(url, { ...init, headers });

    if (response.status !== 402) return response;

    const wwwAuth = response.headers.get("WWW-Authenticate");
    if (!wwwAuth?.startsWith("Payment ")) {
      throw new Error("402 received without a Payment challenge");
    }

    const authHeader = await this.fulfillChallenge(wwwAuth, preferHash);
    headers.set("Authorization", authHeader);

    const retryResponse = await globalThis.fetch(url, { ...init, headers });
    if (retryResponse.status === 402) {
      const body = await retryResponse.json().catch(() => ({}));
      throw new Error(`Payment failed after retry: ${JSON.stringify(body)}`);
    }

    return retryResponse;
  }
}

// ── Convenience builder ────────────────────────────────────────────────────

export const aptos = {
  charge: (opts: ClientChargeMethodConfig): ClientChargeMethodConfig => opts,
};
