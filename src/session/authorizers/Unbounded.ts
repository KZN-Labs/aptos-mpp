import type { Account } from "@aptos-labs/ts-sdk";
import { signVoucher } from "../voucher.js";
import type { SessionAuthorizer } from "../types.js";

/**
 * UnboundedAuthorizer signs every voucher without any budget constraint.
 * Suitable for machine-to-machine clients with pre-approved spending or
 * where the channel deposit amount itself is the only hard limit.
 */
export class UnboundedAuthorizer implements SessionAuthorizer {
  constructor(private readonly signer: Account) {}

  async authorize(params: {
    channelId: string;
    currentCumulative: bigint;
    requestedAmount: bigint;
    nonce: number;
    expiry: number;
  }): Promise<{ cumulativeAmount: bigint; signature: string }> {
    const newCumulative = params.currentCumulative + params.requestedAmount;
    const voucher = await signVoucher(
      this.signer,
      params.channelId,
      newCumulative,
      params.nonce,
      params.expiry,
    );
    return {
      cumulativeAmount: newCumulative,
      signature: voucher.signature,
    };
  }
}
