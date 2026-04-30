import {
  Aptos,
  AptosConfig,
  Network,
  Account,
  type UserTransactionResponse,
} from "@aptos-labs/ts-sdk";
import type { SessionAuthorizer, BuildOpenChannelTx, BuildTopupTx } from "../session/types.js";
import type { ChannelState } from "../session/types.js";
import { APTOS_NETWORKS, PAYMENT_METHOD, PAYMENT_INTENT_SESSION } from "../constants.js";

export interface ClientSessionConfig {
  signer: Account;
  authorizer: SessionAuthorizer;
  buildOpenChannelTx: BuildOpenChannelTx;
  buildTopupTx: BuildTopupTx;
}

export interface MppxSessionClientConfig {
  methods: [ClientSessionConfig];
}

function parseSessionChallenge(wwwAuth: string): {
  challengeId: string;
  requestRaw: string;
} {
  const idMatch = wwwAuth.match(/id="([^"]+)"/);
  const requestMatch = wwwAuth.match(/request="([^"]+)"/);
  if (!idMatch || !requestMatch) throw new Error("Malformed session challenge header");
  return { challengeId: idMatch[1], requestRaw: requestMatch[1] };
}

export class MppxSessionClient {
  private readonly cfg: ClientSessionConfig;
  private channel?: ChannelState;
  private readonly aptosClients = new Map<string, Aptos>();

  constructor(config: MppxSessionClientConfig) {
    this.cfg = config.methods[0];
  }

  static create(config: MppxSessionClientConfig): MppxSessionClient {
    return new MppxSessionClient(config);
  }

  private getAptos(network: string): Aptos {
    if (!this.aptosClients.has(network)) {
      const net = APTOS_NETWORKS[network] ?? Network.TESTNET;
      this.aptosClients.set(network, new Aptos(new AptosConfig({ network: net })));
    }
    return this.aptosClients.get(network)!;
  }

  /**
   * Open a new payment channel in response to a session 402 challenge.
   * The channel is stored in memory for subsequent requests.
   */
  async openChannel(
    wwwAuth: string,
    depositAmount: string,
  ): Promise<string> {
    const { challengeId, requestRaw } = parseSessionChallenge(wwwAuth);
    const request = JSON.parse(Buffer.from(requestRaw, "base64url").toString("utf-8"));
    const md = request.methodDetails;
    const network: "mainnet" | "testnet" | "devnet" | "localnet" = md.network ?? "testnet";

    const expiryTimestamp = Math.floor(Date.now() / 1000) + 3600;

    const txHash = await this.cfg.buildOpenChannelTx({
      signer: this.cfg.signer,
      recipientAddress: request.recipient,
      assetAddress: md.assetAddress,
      tokenStandard: md.tokenStandard ?? "coin",
      depositAmount,
      expiryTimestamp,
      network,
    });

    // Wait for the transaction to be committed, then extract the real channel_id
    // (a u64) from the ChannelOpened event emitted by the Move contract.
    const aptos = this.getAptos(network);
    const committedTx = await aptos.waitForTransaction({ transactionHash: txHash });

    if (committedTx.type !== "user_transaction") {
      throw new Error(`open_channel tx ${txHash} is not a user transaction (got ${committedTx.type})`);
    }
    const userTx = committedTx as UserTransactionResponse;
    const openEvent = userTx.events.find((e) => e.type.endsWith("::channel::ChannelOpened"));
    if (!openEvent) {
      throw new Error(`ChannelOpened event not found in tx ${txHash}. Check the module address.`);
    }
    // The Move contract serialises u64 fields as decimal strings in JSON.
    const channelId = String((openEvent.data as Record<string, unknown>)["channel_id"]);

    // Strip any 0x prefix so the stored key matches the format expected by verifyVoucher.
    const rawPubKey = this.cfg.signer.publicKey.toString();
    const clientPublicKey = rawPubKey.startsWith("0x") ? rawPubKey.slice(2) : rawPubKey;

    this.channel = {
      channelId,
      clientAddress: this.cfg.signer.accountAddress.toString(),
      clientPublicKey,
      recipientAddress: request.recipient,
      assetAddress: md.assetAddress,
      tokenStandard: md.tokenStandard ?? "coin",
      depositedAmount: BigInt(depositAmount),
      cumulativePaid: 0n,
      lastNonce: 0,
      expiryTimestamp,
      openTxHash: txHash,
      network,
    };

    return channelId;
  }

  /**
   * Produce an `Authorization: Payment <b64url>` header for a session request.
   */
  async authorizeRequest(
    challengeId: string,
    amountPerRequest: bigint,
  ): Promise<string> {
    if (!this.channel) throw new Error("No open channel. Call openChannel() first.");

    const nonce = this.channel.lastNonce + 1;
    const expiry = Math.floor(Date.now() / 1000) + 60;

    const { cumulativeAmount, signature } = await this.cfg.authorizer.authorize({
      channelId: this.channel.channelId,
      currentCumulative: this.channel.cumulativePaid,
      requestedAmount: amountPerRequest,
      nonce,
      expiry,
    });

    this.channel.cumulativePaid = cumulativeAmount;
    this.channel.lastNonce = nonce;

    const credential = {
      id: challengeId,
      method: PAYMENT_METHOD,
      intent: PAYMENT_INTENT_SESSION,
      payload: {
        channelId: this.channel.channelId,
        cumulativeAmount: cumulativeAmount.toString(),
        nonce,
        expiry,
        signature,
      },
    };

    return `Payment ${Buffer.from(JSON.stringify(credential)).toString("base64url")}`;
  }

  /**
   * fetch() wrapper with automatic session management.
   * Opens a channel on first 402, then signs vouchers for subsequent requests.
   */
  async fetch(
    url: string,
    init: RequestInit = {},
    amountPerRequest: bigint = 10_000n,
    defaultDepositAmount = "10000000",
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("X-Aptos-Sender", this.cfg.signer.accountAddress.toString());

    // If we already have a channel, attach a voucher immediately
    if (this.channel) {
      const { v4: uuidv4 } = await import("uuid");
      const authHeader = await this.authorizeRequest(uuidv4(), amountPerRequest);
      headers.set("Authorization", authHeader);
    }

    const response = await globalThis.fetch(url, { ...init, headers });
    if (response.status !== 402) return response;

    const wwwAuth = response.headers.get("WWW-Authenticate");
    if (!wwwAuth?.startsWith("Payment ")) {
      throw new Error("402 received without a Payment challenge");
    }

    // Open channel if needed
    if (!this.channel) {
      await this.openChannel(wwwAuth, defaultDepositAmount);
    }

    const { challengeId } = parseSessionChallenge(wwwAuth);
    const authHeader = await this.authorizeRequest(challengeId, amountPerRequest);
    headers.set("Authorization", authHeader);

    return globalThis.fetch(url, { ...init, headers });
  }
}

export const aptosSession = {
  session: (opts: ClientSessionConfig): ClientSessionConfig => opts,
};
