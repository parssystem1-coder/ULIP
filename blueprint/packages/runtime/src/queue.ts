/**
 * Queue transport (Phase 14, ADR-016). Redis/BullMQ is TRANSPORT ONLY: the
 * queue message carries just the persistent job id. Shared by the API
 * (enqueue) and the worker (consume) so both speak the same queue name and
 * options. ioredis is loaded through createRequire to keep CJS/ESM interop
 * explicit.
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

/** Queue name shared by API producer and worker consumer. */
export const ULIP_QUEUE_NAME = 'ulip-jobs';

export class JobQueue {
  private readonly queue: BullQueue<{ jobId: string }>;
  private readonly handle: RedisConnectionHandle;

  constructor(redisUrl: string) {
    this.handle = createRedisConnection(redisUrl);
    this.queue = new BullQueue<{ jobId: string }>(ULIP_QUEUE_NAME, {
      connection: this.handle.connection,
    });
  }

  async add(
    data: { jobId: string },
    opts: {
      priority?: number | undefined;
      attempts?: number | undefined;
      backoff?: { type: string; delay: number } | undefined;
    } = {},
  ): Promise<{ id: string | undefined }> {
    const options: JobsOptions = {
      removeOnComplete: 1000,
      removeOnFail: 1000,
    };
    if (opts.priority !== undefined) options.priority = opts.priority;
    if (opts.attempts !== undefined) options.attempts = opts.attempts;
    if (opts.backoff !== undefined) {
      (options as { backoff?: number | BackoffOptions | undefined }).backoff = opts.backoff as BackoffOptions;
    }
    const job = await this.queue.add(ULIP_QUEUE_NAME, data, options);
    return { id: job.id };
  }

  async close(): Promise<void> {
    await this.queue.close();
    this.handle.disconnect();
  }
}
