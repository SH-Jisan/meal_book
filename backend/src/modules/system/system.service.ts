import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { InjectQueue } from '@nestjs/bullmq';
import { Cron } from '@nestjs/schedule';
import { HttpAdapterHost } from '@nestjs/core';
import type { Cache } from 'cache-manager';
import { Queue } from 'bullmq';
import * as os from 'os';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MetricsInterceptor } from '../../common/interceptors/metrics.interceptors';
import { AppCacheService } from '../../common/cache/app-cache.service';

export interface LogEntry {
  time: string;
  level: 'LOG' | 'WARN' | 'ERROR';
  message: string;
}

@Injectable()
export class SystemService {
  private readonly logger = new Logger(SystemService.name);
  private static recentLogs: LogEntry[] = [];

  constructor(
    private prisma: PrismaService,
    private adapterHost: HttpAdapterHost,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    @InjectQueue('notification-queue') private notificationQueue: Queue,
    private appCache: AppCacheService,
  ) {
    SystemService.addLog('LOG', 'System Observability Engine Initialized');
  }

  public static addLog(level: 'LOG' | 'WARN' | 'ERROR', message: string) {
    const entry: LogEntry = {
      time: new Date().toLocaleTimeString(),
      level,
      message,
    };
    this.recentLogs.unshift(entry);
    if (this.recentLogs.length > 50) this.recentLogs.pop();
  }

  public static getRecentLogs(): LogEntry[] {
    return this.recentLogs;
  }

  // =========================================================================
  // 🧹 1. REDIS CACHE FLUSH & QUEUE RETRY
  // =========================================================================
  async clearSystemCache(type?: string) {
    try {
      SystemService.addLog(
        'WARN',
        `Manual Cache Clear Triggered [${type || 'ALL'}]`,
      );
      await this.appCache.del(`* (Manual Cache Flush [${type || 'ALL'}])`);
      return {
        success: true,
        message: `System Cache [${type || 'ALL'}] successfully invalidated`,
      };
    } catch (err: any) {
      SystemService.addLog('ERROR', `Cache Clear Failed: ${err.message}`);
      return { success: false, message: err.message };
    }
  }

  async retryFailedQueueJobs() {
    try {
      const failedJobs = await this.notificationQueue.getFailed();
      for (const job of failedJobs) {
        await job.retry();
      }
      SystemService.addLog(
        'LOG',
        `Retried ${failedJobs.length} failed BullMQ background jobs`,
      );
      return {
        success: true,
        count: failedJobs.length,
        message: `Retried ${failedJobs.length} failed jobs`,
      };
    } catch (err: any) {
      SystemService.addLog('ERROR', `Queue Retry Failed: ${err.message}`);
      return { success: false, message: err.message };
    }
  }

  // =========================================================================
  // 🔄 CRON JOBS: Monthly, Half-Yearly, Annual Summaries to Supabase
  // =========================================================================
  @Cron('0 0 1 * *')
  async handleMonthlyMetricsCycle() {
    this.logger.log(
      '🔄 Executing Monthly System Metrics Rollup & Archival to Supabase...',
    );
    try {
      const metricsList = MetricsInterceptor.getMetricsList();
      if (!metricsList || metricsList.length === 0) return;

      const now = new Date();
      const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const monthKey = lastMonthDate.toISOString().slice(0, 7);

      await this.prisma.systemMetricSummary.createMany({
        data: metricsList.map((item) => ({
          period: 'MONTHLY',
          periodKey: monthKey,
          routePath: item.path,
          httpMethod: item.method,
          totalRequests: item.totalRequests,
          averageLatencyMs: item.averageLatencyMs,
          averageRamMb: item.averageRamMb,
          averageCpuMs: item.averageCpuMs,
        })),
      });

      const summaryRedisKey = `metrics:summary:monthly:${monthKey}`;
      await this.cacheManager.set(summaryRedisKey, metricsList, 0);

      SystemService.addLog(
        'LOG',
        `Saved 1-Month Metric Rollup for [${monthKey}]`,
      );
    } catch (err: any) {
      SystemService.addLog('ERROR', `Monthly Rollup Failed: ${err.message}`);
    }
  }

  @Cron('0 0 1 1,7 *')
  async handleHalfYearlyMetricsCycle() {
    try {
      const now = new Date();
      const halfKey =
        now.getMonth() < 6
          ? `${now.getFullYear()}-H1`
          : `${now.getFullYear()}-H2`;
      const metricsList = MetricsInterceptor.getMetricsList();

      await this.prisma.systemMetricSummary.createMany({
        data: metricsList.map((item) => ({
          period: 'HALFYEARLY',
          periodKey: halfKey,
          routePath: item.path,
          httpMethod: item.method,
          totalRequests: item.totalRequests,
          averageLatencyMs: item.averageLatencyMs,
          averageRamMb: item.averageRamMb,
          averageCpuMs: item.averageCpuMs,
        })),
      });

      SystemService.addLog(
        'LOG',
        `Saved 6-Month Macro Metric Rollup for [${halfKey}]`,
      );
    } catch (err: any) {
      SystemService.addLog('ERROR', `6-Month Rollup Failed: ${err.message}`);
    }
  }

  @Cron('0 0 1 1 *')
  async handleAnnualMetricsCycle() {
    try {
      const lastYear = `${new Date().getFullYear() - 1}`;
      const metricsList = MetricsInterceptor.getMetricsList();

      await this.prisma.systemMetricSummary.createMany({
        data: metricsList.map((item) => ({
          period: 'ANNUAL',
          periodKey: lastYear,
          routePath: item.path,
          httpMethod: item.method,
          totalRequests: item.totalRequests,
          averageLatencyMs: item.averageLatencyMs,
          averageRamMb: item.averageRamMb,
          averageCpuMs: item.averageCpuMs,
        })),
      });

      SystemService.addLog(
        'LOG',
        `Saved Annual Metric Rollup for [${lastYear}]`,
      );
    } catch (err: any) {
      SystemService.addLog('ERROR', `Annual Rollup Failed: ${err.message}`);
    }
  }

  // =========================================================================
  // 📈 SYSTEM METRICS TELEMETRY DISPATCHER
  // =========================================================================
  async getSystemMetrics() {
    this.scanAndRegisterRoutes();
    const memoryUsage = process.memoryUsage();
    const systemTotalMemory = os.totalmem();
    const systemFreeMemory = os.freemem();
    const heapPercent = Number(
      ((memoryUsage.heapUsed / memoryUsage.heapTotal) * 100).toFixed(1),
    );

    const dbStartTime = Date.now();
    let dbStatus = 'HEALTHY';
    let dbLatencyMs = 0;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      dbLatencyMs = Date.now() - dbStartTime;
    } catch {
      dbStatus = 'UNHEALTHY';
    }

    let queueMetrics = { waiting: 0, active: 0, completed: 0, failed: 0 };
    try {
      const counts = await this.notificationQueue.getJobCounts(
        'waiting',
        'active',
        'completed',
        'failed',
      );
      queueMetrics = {
        waiting: counts.waiting || 0,
        active: counts.active || 0,
        completed: counts.completed || 0,
        failed: counts.failed || 0,
      };
    } catch (_err) {
      this.logger.debug('Suppressed error');
    }

    let healthScore = 100;
    if (dbStatus !== 'HEALTHY') healthScore -= 40;
    if (dbLatencyMs > 200) healthScore -= 15;
    if (heapPercent > 85) healthScore -= 20;

    const apiMetrics = MetricsInterceptor.getMetricsList();
    const totalSystemRequests = apiMetrics.reduce(
      (sum, item) => sum + item.totalRequests,
      0,
    );
    const totalSuccessfulRequests = apiMetrics.reduce(
      (sum, item) => sum + item.successfulRequests,
      0,
    );
    const totalFailedRequests = apiMetrics.reduce(
      (sum, item) => sum + item.failedRequests,
      0,
    );
    const successRate =
      totalSystemRequests > 0
        ? Number(
            ((totalSuccessfulRequests / totalSystemRequests) * 100).toFixed(1),
          )
        : 100;

    return {
      status: 'OK',
      timestamp: new Date().toISOString(),
      engine: {
        nodeVersion: process.version,
        pid: process.pid,
        platform: os.platform(),
        env: process.env.NODE_ENV || 'development',
      },
      healthScore: Math.max(0, healthScore),
      uptime: {
        seconds: Math.floor(process.uptime()),
        formatted: this.formatUptime(process.uptime()),
      },
      memory: {
        processRssMb: (memoryUsage.rss / 1024 / 1024).toFixed(2),
        heapTotalMb: (memoryUsage.heapTotal / 1024 / 1024).toFixed(2),
        heapUsedMb: (memoryUsage.heapUsed / 1024 / 1024).toFixed(2),
        heapPercent,
        systemTotalRamGb:
          (systemTotalMemory / 1024 / 1024 / 1024).toFixed(2) + ' GB',
        systemFreeRamGb:
          (systemFreeMemory / 1024 / 1024 / 1024).toFixed(2) + ' GB',
      },
      cpu: {
        cores: os.cpus().length,
        model: os.cpus()[0]?.model || 'Unknown',
        loadAverage: os.loadavg(),
      },
      database: {
        status: dbStatus,
        latencyMs: `${dbLatencyMs} ms`,
        latencyValue: dbLatencyMs,
      },
      queue: queueMetrics,
      cacheTelemetry: this.appCache.getTelemetry(),
      trafficSummary: {
        totalRequests: totalSystemRequests,
        successfulRequests: totalSuccessfulRequests,
        failedRequests: totalFailedRequests,
        successRatePercent: successRate,
      },
      logs: SystemService.getRecentLogs(),
      apiMetrics,
    };
  }

  private scanAndRegisterRoutes() {
    try {
      const instance = this.adapterHost?.httpAdapter?.getInstance();
      const router = instance?._router || instance?.router;
      if (router && router.stack) {
        const routes: Array<{ method: string; path: string }> = [];
        router.stack.forEach((layer: any) => {
          if (layer.route) {
            const path = layer.route.path;
            const methods = Object.keys(layer.route.methods);
            methods.forEach((m) => {
              routes.push({ method: m.toUpperCase(), path });
            });
          }
        });
        MetricsInterceptor.initializeRegisteredRoutes(routes);
      }
    } catch (_err) {
      this.logger.debug('Suppressed error');
    }
  }

  private formatUptime(seconds: number): string {
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    return `${d}d ${h}h ${m}m ${s}s`;
  }
}
