export interface ChallengeRecord {
  challengeId: string;
  amount: string;
  currency: string;
  recipient: string;
  senderAddress?: string;
  sequenceNumber?: string;
  expirationTimestampSecs?: number;
  createdAt: number;
}

/**
 * Idempotency and sequence-lock store.
 *
 * - markUsed / isUsed: prevent the same challengeId from being settled twice.
 * - lockSequenceNumber / unlockSequenceNumber: prevent the same Aptos sequence
 *   number from being included in two concurrent challenges for the same sender.
 * - storeChallenge / getChallenge: correlate credential payloads back to the
 *   original challenge (needed for push-mode verification).
 */
export interface IdempotencyStore {
  markUsed(challengeId: string, ttlSeconds: number): Promise<boolean>;
  isUsed(challengeId: string): Promise<boolean>;
  lockSequenceNumber(
    senderAddress: string,
    challengeId: string,
    ttlSeconds: number,
  ): Promise<boolean>;
  unlockSequenceNumber(senderAddress: string): Promise<void>;
  storeChallenge(
    challengeId: string,
    record: ChallengeRecord,
    ttlSeconds: number,
  ): Promise<void>;
  getChallenge(challengeId: string): Promise<ChallengeRecord | undefined>;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

function notExpired<T>(entry: Entry<T>): boolean {
  return Date.now() < entry.expiresAt;
}

/**
 * In-memory IdempotencyStore. Suitable for single-process dev/test only.
 *
 * For production use Redis with SETNX + EX to get atomic compare-and-swap
 * semantics across multiple server instances.
 */
export class InMemoryStore implements IdempotencyStore {
  private readonly used = new Map<string, Entry<true>>();
  private readonly seqLocks = new Map<string, Entry<string>>();
  private readonly challenges = new Map<string, Entry<ChallengeRecord>>();

  async markUsed(challengeId: string, ttlSeconds: number): Promise<boolean> {
    const existing = this.used.get(challengeId);
    if (existing && notExpired(existing)) return false;
    this.used.set(challengeId, {
      value: true,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    return true;
  }

  async isUsed(challengeId: string): Promise<boolean> {
    const entry = this.used.get(challengeId);
    return entry !== undefined && notExpired(entry);
  }

  async lockSequenceNumber(
    senderAddress: string,
    challengeId: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const existing = this.seqLocks.get(senderAddress);
    if (existing && notExpired(existing)) return false;
    this.seqLocks.set(senderAddress, {
      value: challengeId,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    return true;
  }

  async unlockSequenceNumber(senderAddress: string): Promise<void> {
    this.seqLocks.delete(senderAddress);
  }

  async storeChallenge(
    challengeId: string,
    record: ChallengeRecord,
    ttlSeconds: number,
  ): Promise<void> {
    this.challenges.set(challengeId, {
      value: record,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async getChallenge(
    challengeId: string,
  ): Promise<ChallengeRecord | undefined> {
    const entry = this.challenges.get(challengeId);
    if (!entry || !notExpired(entry)) return undefined;
    return entry.value;
  }
}
