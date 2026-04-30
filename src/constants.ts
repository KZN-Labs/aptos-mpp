import { Network } from "@aptos-labs/ts-sdk";

export const PAYMENT_METHOD = "aptos" as const;
export const PAYMENT_INTENT_CHARGE = "charge" as const;
export const PAYMENT_INTENT_SESSION = "session" as const;

// Aptos Network enum mapping
export const APTOS_NETWORKS: Record<string, Network> = {
  mainnet: Network.MAINNET,
  testnet: Network.TESTNET,
  devnet: Network.DEVNET,
  localnet: Network.LOCAL,
};

// Default RPC endpoints (SDK uses these internally when you pass Network enum)
export const NETWORK_URLS: Record<string, string> = {
  mainnet: "https://api.mainnet.aptoslabs.com/v1",
  testnet: "https://api.testnet.aptoslabs.com/v1",
  devnet: "https://api.devnet.aptoslabs.com/v1",
  localnet: "http://127.0.0.1:8080/v1",
};

// Aptos chain IDs
export const CHAIN_IDS: Record<string, number> = {
  mainnet: 1,
  testnet: 2,
  devnet: 32,
  localnet: 4,
};

// Native APT coin type (Legacy Coin standard)
export const APT_COIN_TYPE = "0x1::aptos_coin::AptosCoin";
export const APT_DECIMALS = 8;

// Circle USDC on Aptos (Fungible Asset standard, mainnet)
// Source: https://developers.circle.com/stablecoins/usdc-on-aptos
// Verify at https://explorer.aptoslabs.com before mainnet use.
export const USDC_MAINNET_FA_ADDRESS =
  "0xbae207659db88bea0cbead6da0c58b8b7a695f65ef13cf2f9de3e61d83d05a7b";
export const USDC_DECIMALS = 6;

// Challenge / transaction defaults
export const DEFAULT_EXPIRY_SECONDS = 120;      // 2-minute challenge window
export const SEQUENCE_LOCK_TTL_SECONDS = 130;   // slightly longer than challenge window
export const CONFIRMATION_TIMEOUT_MS = 30_000;  // 30s settlement timeout
export const CHALLENGE_STORE_TTL_SECONDS = 300; // 5-minute idempotency window
