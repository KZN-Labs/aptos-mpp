import type { Account } from "@aptos-labs/ts-sdk";

export interface ChannelState {
  channelId: string;
  clientAddress: string;
  /** Ed25519 public key of the client — hex string without 0x prefix, read from on-chain. */
  clientPublicKey: string;
  recipientAddress: string;
  assetAddress: string | undefined;
  tokenStandard: "coin" | "fa";
  /** Total deposited into the channel (base units) */
  depositedAmount: bigint;
  /** Running total the server has deducted (base units) */
  cumulativePaid: bigint;
  /** Highest nonce the server has accepted */
  lastNonce: number;
  /** Unix timestamp when the channel expires */
  expiryTimestamp: number;
  /** On-chain open transaction hash */
  openTxHash: string;
  network: "mainnet" | "testnet" | "devnet" | "localnet";
}

export interface SessionPricing {
  unit: "request" | "token" | "second" | "byte";
  amountPerUnit: string;
  meter?: string;
}

export interface SessionDefaults {
  suggestedDeposit: string;
  ttlSeconds: number;
}

export type BuildOpenChannelTx = (params: {
  signer: Account;
  recipientAddress: string;
  assetAddress: string | undefined;
  tokenStandard: "coin" | "fa";
  depositAmount: string;
  expiryTimestamp: number;
  network: "mainnet" | "testnet" | "devnet" | "localnet";
}) => Promise<string>;

export type BuildTopupTx = (params: {
  signer: Account;
  channelId: string;
  additionalAmount: string;
  network: "mainnet" | "testnet" | "devnet" | "localnet";
}) => Promise<string>;

export interface SessionAuthorizer {
  /**
   * Called before each payment request. Should sign a voucher if the request
   * is within the authorizer's budget, or throw if it is not.
   */
  authorize(params: {
    channelId: string;
    currentCumulative: bigint;
    requestedAmount: bigint;
    nonce: number;
    expiry: number;
  }): Promise<{ cumulativeAmount: bigint; signature: string }>;
}
