import type { IdempotencyStore, ChallengeRecord } from "./Store.js";

/**
 * Minimal Redis-compatible interface.
 * Pass an ioredis v5 (`new Redis(url)`) or compatible client.
 * Defined here so ioredis stays an optional peer dependency with no compile-time
 * import required from consumers who don't use Redis.
 */
export interface RedisLike {
  set(key: string, value: string, ...options: (string | number)[]): Promise<"OK" | null>;
  get(key: string): Promise<string | null>;
  exists(...keys: string[]): Promise<number>;
  del(...keys: string[]): Promise<number>;
}

const P = "mppx:";

/**
 * Redis-backed IdempotencyStore for production deployments.
 *
 * Uses atomic SET NX EX for sequence locking and idempotency marking,
 * which is safe across multiple server instances — unlike InMemoryStore.
 *
 * Usage:
 * ```ts
 * import Redis from "ioredis";
 * import { RedisStore } from "@aptos/mpp/server";
 *
 * const mppx = MppxServer.create({
 *   ...,
 *   store: new RedisStore(new Redis(process.env.REDIS_URL)),
 * });
 * ```
 */
export class RedisStore implements IdempotencyStore {
  constructor(private readonly redis: RedisLike) {}

  async markUsed(challengeId: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.set(
      `${P}used:${challengeId}`,
      "1",
      "EX",
      ttlSeconds,
      "NX",
    );
    return result === "OK";
  }

  async isUsed(challengeId: string): Promise<boolean> {
    return (await this.redis.exists(`${P}used:${challengeId}`)) === 1;
  }

  async lockSequenceNumber(
    senderAddress: string,
    challengeId: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const result = await this.redis.set(
      `${P}seqlock:${senderAddress}`,
      challengeId,
      "EX",
      ttlSeconds,
      "NX",
    );
    return result === "OK";
  }

  async unlockSequenceNumber(senderAddress: string): Promise<void> {
    await this.redis.del(`${P}seqlock:${senderAddress}`);
  }

  async storeChallenge(
    challengeId: string,
    record: ChallengeRecord,
    ttlSeconds: number,
  ): Promise<void> {
    await this.redis.set(
      `${P}challenge:${challengeId}`,
      JSON.stringify(record),
      "EX",
      ttlSeconds,
    );
  }

  async getChallenge(challengeId: string): Promise<ChallengeRecord | undefined> {
    const raw = await this.redis.get(`${P}challenge:${challengeId}`);
    if (!raw) return undefined;
    return JSON.parse(raw) as ChallengeRecord;
  }
}
