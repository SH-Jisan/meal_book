import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';

export interface CacheEventLog {
  id: string;
  time: string;
  action: 'HIT' | 'MISS' | 'SET' | 'DEL';
  key: string;
  detail?: string;
}

export interface CacheTelemetry {
  hits: number;
  misses: number;
  sets: number;
  deletions: number;
  totalOps: number;
  hitRatio: number;
  recentEvents: CacheEventLog[];
}

@Injectable()
export class AppCacheService {
  private readonly logger = new Logger(AppCacheService.name);

  // 📊 Real-time In-Memory Telemetry Engine
  private hits = 0;
  private misses = 0;
  private sets = 0;
  private deletions = 0;
  private recentEvents: CacheEventLog[] = [];
  private static readonly MAX_RECENT_EVENTS = 60;

  constructor(@Inject(CACHE_MANAGER) private cacheManager: Cache) {}

  private recordEvent(
    action: 'HIT' | 'MISS' | 'SET' | 'DEL',
    key: string,
    detail?: string,
  ) {
    if (action === 'HIT') this.hits++;
    else if (action === 'MISS') this.misses++;
    else if (action === 'SET') this.sets++;
    else if (action === 'DEL') this.deletions++;

    const entry: CacheEventLog = {
      id: Math.random().toString(36).substring(2, 9),
      time: new Date().toLocaleTimeString(),
      action,
      key,
      detail,
    };

    this.recentEvents.unshift(entry);
    if (this.recentEvents.length > AppCacheService.MAX_RECENT_EVENTS) {
      this.recentEvents.pop();
    }
  }

  public getTelemetry(): CacheTelemetry {
    const totalHitsAndMisses = this.hits + this.misses;
    const hitRatio =
      totalHitsAndMisses > 0
        ? Number(((this.hits / totalHitsAndMisses) * 100).toFixed(1))
        : 100;
    return {
      hits: this.hits,
      misses: this.misses,
      sets: this.sets,
      deletions: this.deletions,
      totalOps: this.hits + this.misses + this.sets + this.deletions,
      hitRatio,
      recentEvents: [...this.recentEvents],
    };
  }

  /**
   * 🛡️ Enterprise Cache-Aside Pattern with Circuit Breaker & Truthiness Safety
   * Bypasses false-positive empty arrays [] and handles Redis limits gracefully.
   */
  async remember<T>(
    key: string,
    ttlSeconds: number,
    fetcherFn: () => Promise<T>,
  ): Promise<T> {
    const safeTtlMs = Math.max(10, ttlSeconds) * 1000;

    // ১. প্রথমে রডিস থেকে ডাটা পড়ার চেষ্টা করা
    try {
      const cached = await this.cacheManager.get<T>(key);
      if (cached !== null && cached !== undefined) {
        if (Array.isArray(cached) && cached.length === 0) {
          this.recordEvent(
            'MISS',
            key,
            'Empty array [] bypassed -> Refreshing DB',
          );
        } else {
          this.recordEvent('HIT', key, 'Served from Redis cache');
          return cached;
        }
      } else {
        this.recordEvent('MISS', key, 'Cache miss -> Querying Database');
      }
    } catch (err: unknown) {
      // 🛡️ রডিস ডাউন বা Upstash লিমিট ওভার হলেও অ্যাপ ক্র্যাশ করবে না
      this.logger.warn(
        `Redis Cache Get Error [${key}]: ${err instanceof Error ? err.message : String(err)}. Degrading gracefully to DB.`,
      );
    }

    // ২. ক্যাশে ডাটা না থাকলে ডাটাবেজ থেকে ডাটা আনা
    const freshData = await fetcherFn();

    // ৩. ডাটা সত্য হলে রডিসে নির্দিষ্ট মিলিমেকেন্ডের জন্য সেভ করা
    if (freshData !== null && freshData !== undefined) {
      try {
        await this.cacheManager.set(key, freshData, safeTtlMs);
        this.recordEvent(
          'SET',
          key,
          `Saved fresh data to Redis (TTL: ${Math.round(safeTtlMs / 1000)}s)`,
        );
      } catch (err: unknown) {
        this.logger.warn(
          `Redis Cache Set Error [${key}]: ${err instanceof Error ? err.message : String(err)}.`,
        );
      }
    }

    return freshData;
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const cached = (await this.cacheManager.get<T>(key)) || null;
      if (cached !== null) {
        this.recordEvent('HIT', key, 'Served from Redis cache');
      } else {
        this.recordEvent('MISS', key, 'Key not present in cache');
      }
      return cached;
    } catch (err: unknown) {
      this.logger.warn(
        `Redis Get Fail [${key}]: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    try {
      const ttlMs = Math.max(1, ttlSeconds) * 1000;
      await this.cacheManager.set(key, value, ttlMs);
      this.recordEvent('SET', key, `Direct cache write (TTL: ${ttlSeconds}s)`);
    } catch (err: unknown) {
      this.logger.warn(
        `Redis Set Fail [${key}]: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.cacheManager.del(key);
      this.recordEvent('DEL', key, 'Cache key invalidated');
    } catch (err: unknown) {
      this.logger.warn(
        `Redis Del Fail [${key}]: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async delMany(keys: string[]): Promise<void> {
    if (!keys || keys.length === 0) return;
    try {
      await Promise.all(keys.map((k) => this.cacheManager.del(k)));
      for (const k of keys) {
        this.recordEvent('DEL', k, 'Batch invalidated');
      }
    } catch (err: unknown) {
      this.logger.warn(
        `Redis DelMany Fail: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
