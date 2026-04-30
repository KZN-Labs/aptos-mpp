import type { Account } from "@aptos-labs/ts-sdk";
import { signVoucher } from "../voucher.js";
import type { SessionAuthorizer } from "../types.js";

export interface RegularBudgetOptions {
  signer: Account;
  /** Maximum total spend per period (base units) */
  budgetPerPeriod: bigint;
  /** Period length in seconds */
  periodSeconds: number;
}

interface PeriodState {
  periodStart: number;
  spent: bigint;
}

/**
 * RegularBudgetAuthorizer approves vouchers up to a per-period budget.
 * Once the budget is exhausted for the current period the authorizer throws,
 * pausing payments until the next period begins.
 */
export class RegularBudgetAuthorizer implements SessionAuthorizer {
  private readonly opts: RegularBudgetOptions;
  private period: PeriodState;

  constructor(opts: RegularBudgetOptions) {
    this.opts = opts;
    this.period = { periodStart: Math.floor(Date.now() / 1000), spent: 0n };
  }

  private currentPeriodStart(): number {
    const now = Math.floor(Date.now() / 1000);
    const elapsed = now - this.period.periodStart;
    if (elapsed >= this.opts.periodSeconds) {
      const periods = Math.floor(elapsed / this.opts.periodSeconds);
      this.period = {
        periodStart: this.period.periodStart + periods * this.opts.periodSeconds,
        spent: 0n,
      };
    }
    return this.period.periodStart;
  }

  async authorize(params: {
    channelId: string;
    currentCumulative: bigint;
    requestedAmount: bigint;
    nonce: number;
    expiry: number;
  }): Promise<{ cumulativeAmount: bigint; signature: string }> {
    this.currentPeriodStart(); // refresh period if needed

    const remaining = this.opts.budgetPerPeriod - this.period.spent;
    if (params.requestedAmount > remaining) {
      throw new Error(
        `Budget exhausted: requested ${params.requestedAmount}, remaining ${remaining} this period`,
      );
    }

    const newCumulative = params.currentCumulative + params.requestedAmount;
    const voucher = await signVoucher(
      this.opts.signer,
      params.channelId,
      newCumulative,
      params.nonce,
      params.expiry,
    );

    this.period.spent += params.requestedAmount;

    return { cumulativeAmount: newCumulative, signature: voucher.signature };
  }
}
