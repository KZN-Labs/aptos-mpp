import type { ChannelStore } from "./ChannelStore.js";
import type { ChannelState } from "./types.js";

/**
 * Minimal Redis-compatible interface for the channel store.
 * Pass an ioredis v5 (`new Redis(url)`) or compatible client.
 */
export interface RedisLike {
  set(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  sadd(key: string, member: string): Promise<number>;
  srem(key: string, member: string): Promise<number>;
  smembers(key: string): Promise<string[]>;
  mget(...keys: string[]): Promise<(string | null)[]>;
}

const CH  = "mppx:ch:";
const IDX = "mppx:client:";

// ChannelState has bigint fields (depositedAmount, cumulativePaid) which
// JSON.stringify can't handle natively — serialise them as decimal strings.
interface SerializedChannel extends Omit<ChannelState, "depositedAmount" | "cumulativePaid"> {
  depositedAmount: string;
  cumulativePaid:  string;
}

function serialize(s: ChannelState): string {
  const obj: SerializedChannel = {
    ...s,
    depositedAmount: s.depositedAmount.toString(),
    cumulativePaid:  s.cumulativePaid.toString(),
  };
  return JSON.stringify(obj);
}

function deserialize(raw: string): ChannelState {
  const obj = JSON.parse(raw) as SerializedChannel;
  return {
    ...obj,
    depositedAmount: BigInt(obj.depositedAmount),
    cumulativePaid:  BigInt(obj.cumulativePaid),
  };
}

/**
 * Redis-backed ChannelStore for production deployments.
 *
 * Maintains a secondary index `mppx:client:<address>` (Redis Set of channelIds)
 * to support `listByClient` without a full scan.
 *
 * Usage:
 * ```ts
 * import Redis from "ioredis";
 * import { RedisChannelStore } from "@aptos/mpp";
 *
 * const sessionServer = MppxSessionServer.create({
 *   ...,
 *   store: new RedisChannelStore(new Redis(process.env.REDIS_URL)),
 * });
 * ```
 */
export class RedisChannelStore implements ChannelStore {
  constructor(private readonly redis: RedisLike) {}

  async save(channel: ChannelState): Promise<void> {
    await Promise.all([
      this.redis.set(`${CH}${channel.channelId}`, serialize(channel)),
      this.redis.sadd(`${IDX}${channel.clientAddress}`, channel.channelId),
    ]);
  }

  async get(channelId: string): Promise<ChannelState | undefined> {
    const raw = await this.redis.get(`${CH}${channelId}`);
    if (!raw) return undefined;
    return deserialize(raw);
  }

  async update(channelId: string, patch: Partial<ChannelState>): Promise<void> {
    const existing = await this.get(channelId);
    if (!existing) throw new Error(`Channel ${channelId} not found`);
    await this.redis.set(`${CH}${channelId}`, serialize({ ...existing, ...patch }));
  }

  async delete(channelId: string): Promise<void> {
    const existing = await this.get(channelId);
    if (!existing) return;
    await Promise.all([
      this.redis.del(`${CH}${channelId}`),
      this.redis.srem(`${IDX}${existing.clientAddress}`, channelId),
    ]);
  }

  async listByClient(clientAddress: string): Promise<ChannelState[]> {
    const ids = await this.redis.smembers(`${IDX}${clientAddress}`);
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(...ids.map((id) => `${CH}${id}`));
    return raws
      .filter((raw): raw is string => raw !== null)
      .map(deserialize);
  }
}
