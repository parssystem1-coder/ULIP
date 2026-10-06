/**
 * Queue transport helpers (Phase 14). BullMQ needs an ioredis-compatible
 * connection; this wrapper creates one and enqueues persistent job ids.
 * ioredis is loaded through createRequire to keep CJS/ESM interop explicit.
 */

import { createRequire } from 'node:module';
import { Queue as BullQueue, type BackoffOptions, type ConnectionOptions, type JobsOptions } from 'bullmq';

const requireCjs = createRequire(import.meta.url);

interface RedisLikeClient {
  disconnect(): void;
}

interface IoRedisCtor {
  new (url: string, opts?: Record<string, unknown>): RedisLikeClient & Record<string, unknown>;
}

export interface RedisConnectionHandle {
  /** Raw ioredis instance, acceptable as a BullMQ ConnectionOptions. */
  connection: ConnectionOptions;
  disconnect(): void;
}

export function createRedisConnection(redisUrl: string): RedisConnectionHandle {
  const IoRedis = requireCjs('ioredis') as IoRedisCtor;
  const client = new IoRedis(redisUrl, { maxRetriesPerRequest: null });
  return {
    connection: client as unknown as ConnectionOptions,
    disconnect(): void {
      client.disconnect();
    },
  };
}

export class Queue {
  private readonly queue: BullQueue<{ jobId: string }>;
  private readonly handle: RedisConnectionHandle;

  constructor(redisUrl: string) {
    this.handle = createRedisConnection(redisUrl);
    this.queue = new BullQueue<{ jobId: string }>('ulip-jobs', {
      connection: this.handle.connection,
    });
  }

  async add(
    name: string,
    data: { jobId: string },
    opts: {
      priority?: number | undefined;
      attempts?: number | undefined;
      backoff?: { type: string; delay: number } | undefined;
      delay?: number | undefined;
    },
  ): Promise<{ id: string | undefined }> {
    const options: JobsOptions = {
      removeOnComplete: 1000,
      removeOnFail: 1000,
    };
    if (opts.delay !== undefined) options.delay = opts.delay;
    if (opts.priority !== undefined) options.priority = opts.priority;
    if (opts.attempts !== undefined) options.attempts = opts.attempts;
    if (opts.backoff !== undefined) {
      (options as { backoff?: number | BackoffOptions | undefined }).backoff = opts.backoff as BackoffOptions;
    }
    const job = await this.queue.add(name, data, options);
    return { id: job.id };
  }

  async close(): Promise<void> {
    await this.queue.close();
    this.handle.disconnect();
  }
}
