import type { ChannelState } from "./types.js";

/**
 * Pluggable persistence interface for payment channel state.
 * The default implementation is in-memory (not production-safe).
 * For production, implement this against Redis, Postgres, etc.
 */
export interface ChannelStore {
  save(channel: ChannelState): Promise<void>;
  get(channelId: string): Promise<ChannelState | undefined>;
  update(channelId: string, patch: Partial<ChannelState>): Promise<void>;
  delete(channelId: string): Promise<void>;
  /** List all open channels for a given client address. */
  listByClient(clientAddress: string): Promise<ChannelState[]>;
}

/**
 * In-memory ChannelStore. Suitable for development and tests only.
 * Data is lost on process restart.
 */
export class InMemoryChannelStore implements ChannelStore {
  private readonly map = new Map<string, ChannelState>();

  async save(channel: ChannelState): Promise<void> {
    this.map.set(channel.channelId, { ...channel });
  }

  async get(channelId: string): Promise<ChannelState | undefined> {
    const ch = this.map.get(channelId);
    return ch ? { ...ch } : undefined;
  }

  async update(channelId: string, patch: Partial<ChannelState>): Promise<void> {
    const existing = this.map.get(channelId);
    if (!existing) throw new Error(`Channel ${channelId} not found`);
    this.map.set(channelId, { ...existing, ...patch });
  }

  async delete(channelId: string): Promise<void> {
    this.map.delete(channelId);
  }

  async listByClient(clientAddress: string): Promise<ChannelState[]> {
    return [...this.map.values()].filter(
      (ch) => ch.clientAddress === clientAddress,
    );
  }
}
