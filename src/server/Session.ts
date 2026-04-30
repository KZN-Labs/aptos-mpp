import {
  Aptos,
  AptosConfig,
  Network,
} from "@aptos-labs/ts-sdk";
import { APTOS_NETWORKS } from "../constants.js";
import {
  SessionCredentialSchema,
} from "../protocol.js";
import { verifyVoucher } from "../session/voucher.js";
import type { ChannelState } from "../session/types.js";
import type { ChannelStore } from "../session/ChannelStore.js";
import { InMemoryChannelStore } from "../session/ChannelStore.js";

export interface ServerSessionConfig {
  network: "mainnet" | "testnet" | "devnet" | "localnet";
  recipient: string;
  assetAddress?: string;
  tokenStandard?: "coin" | "fa";
  decimals: number;
  channelModuleAddress: string;
  pricing: {
    unit: "request" | "token" | "second" | "byte";
    amountPerUnit: string;
    meter?: string;
  };
  sessionDefaults: {
    suggestedDeposit: string;
    ttlSeconds: number;
  };
}

export interface MppxSessionServerConfig {
  secretKey?: string;
  methods: ServerSessionConfig[];
  store?: ChannelStore;
}

export class MppxSessionServer {
  private readonly config: ServerSessionConfig;
  private readonly store: ChannelStore;
  private readonly aptos: Aptos;

  constructor(cfg: MppxSessionServerConfig) {
    this.config = cfg.methods[0];
    this.store = cfg.store ?? new InMemoryChannelStore();
    const network = APTOS_NETWORKS[this.config.network] ?? Network.TESTNET;
    this.aptos = new Aptos(new AptosConfig({ network }));
  }

  static create(cfg: MppxSessionServerConfig): MppxSessionServer {
    return new MppxSessionServer(cfg);
  }

  /**
   * Issue a session challenge. Called when the client has no valid channel yet.
   */
  async issueSessionChallenge(params: {
    clientAddress?: string;
  }): Promise<{ status: 402; headers: Record<string, string>; body: object }> {
    const { v4: uuidv4 } = await import("uuid");
    const challengeId = uuidv4();

    const request = {
      currency: "APT", // overridden by server config in production
      recipient: this.config.recipient,
      suggestedDeposit: this.config.sessionDefaults.suggestedDeposit,
      methodDetails: {
        network: this.config.network,
        assetAddress: this.config.assetAddress,
        tokenStandard: this.config.tokenStandard,
        decimals: this.config.decimals,
        acceptedTypes: ["transaction", "hash"],
      },
    };

    const encoded = Buffer.from(JSON.stringify(request)).toString("base64url");

    return {
      status: 402,
      headers: {
        "WWW-Authenticate": `Payment id="${challengeId}", method="aptos", intent="session", request="${encoded}"`,
        "Content-Type": "application/json",
      },
      body: {
        error: "payment_required",
        message: "Open a payment channel to access this resource.",
        retryable: false,
      },
    };
  }

  /**
   * Verify a session voucher from an `Authorization: Payment <b64url>` header.
   * Deducts `amountPerUnit` from the channel balance if valid.
   */
  async verifyVoucher(authHeader: string): Promise<{
    channelId: string;
    cumulativePaid: bigint;
  }> {
    if (!authHeader.startsWith("Payment ")) {
      throw new Error("Authorization header must use Payment scheme");
    }

    const encoded = authHeader.slice("Payment ".length).trim();
    const raw = JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8"));
    const credential = SessionCredentialSchema.parse(raw);
    const voucher = credential.payload;

    const channel = await this.store.get(voucher.channelId);
    if (!channel) {
      throw new Error(`Channel ${voucher.channelId} not found`);
    }

    // Expiry
    if (Math.floor(Date.now() / 1000) > voucher.expiry) {
      throw new Error("Voucher has expired");
    }

    // Monotonicity
    if (voucher.nonce <= channel.lastNonce) {
      throw new Error(
        `Stale nonce: received ${voucher.nonce}, expected > ${channel.lastNonce}`,
      );
    }

    // Amount monotonicity
    const newCumulative = BigInt(voucher.cumulativeAmount);
    if (newCumulative <= channel.cumulativePaid) {
      throw new Error(
        `Cumulative amount must be > ${channel.cumulativePaid}, got ${newCumulative}`,
      );
    }

    // Cryptographic verification: the client's Ed25519 public key was read from the
    // chain when the channel was registered (see registerChannel). Verify the voucher
    // signature now so a bad actor cannot drain a channel they don't control.
    const voucherForVerify: import("../protocol.js").SessionVoucher = {
      channelId: voucher.channelId,
      cumulativeAmount: voucher.cumulativeAmount,
      nonce: voucher.nonce,
      expiry: voucher.expiry,
      signature: voucher.signature,
    };
    if (!verifyVoucher(voucherForVerify, channel.clientPublicKey)) {
      throw new Error("Voucher signature is invalid");
    }

    // Update state
    await this.store.update(voucher.channelId, {
      cumulativePaid: newCumulative,
      lastNonce: voucher.nonce,
    });

    return { channelId: voucher.channelId, cumulativePaid: newCumulative };
  }

  /**
   * Register a newly opened channel. Reads the client's Ed25519 public key directly
   * from the Move contract via `get_client_public_key` — the server never trusts a
   * client-supplied key value.
   */
  async registerChannel(params: {
    channelId: string;
    clientAddress: string;
    depositAmount: string;
    openTxHash: string;
  }): Promise<void> {
    // Fetch the public key that was embedded on-chain when the channel was opened.
    // The view function returns vector<u8> as a 0x-prefixed hex string.
    const viewResult = await this.aptos.view({
      payload: {
        function: `${this.config.channelModuleAddress}::channel::get_client_public_key`,
        functionArguments: [params.channelId],
      },
    });
    const rawKey = viewResult[0] as string;
    const clientPublicKey = rawKey.startsWith("0x") ? rawKey.slice(2) : rawKey;

    const channel: ChannelState = {
      channelId: params.channelId,
      clientAddress: params.clientAddress,
      clientPublicKey,
      recipientAddress: this.config.recipient,
      assetAddress: this.config.assetAddress,
      tokenStandard: this.config.tokenStandard ?? "coin",
      depositedAmount: BigInt(params.depositAmount),
      cumulativePaid: 0n,
      lastNonce: 0,
      expiryTimestamp: Math.floor(Date.now() / 1000) + this.config.sessionDefaults.ttlSeconds,
      openTxHash: params.openTxHash,
      network: this.config.network,
    };
    await this.store.save(channel);
  }
}
