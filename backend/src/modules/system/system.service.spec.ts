import { AppCacheService } from '../../common/cache/app-cache.service';
import { getQueueToken } from '@nestjs/bullmq';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { HttpAdapterHost } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SystemService } from './system.service';

describe('SystemService (Unit Tests)', () => {
  let service: SystemService;

  const mockPrismaService = {
    $queryRaw: jest.fn().mockResolvedValue([1]),
  };

  const mockQueue = {
    getJobCounts: jest
      .fn()
      .mockResolvedValue({ waiting: 0, active: 1, completed: 10, failed: 0 }),
    getWaitingCount: jest.fn().mockResolvedValue(0),
    getActiveCount: jest.fn().mockResolvedValue(1),
    getCompletedCount: jest.fn().mockResolvedValue(10),
    getFailedCount: jest.fn().mockResolvedValue(0),
  };

  const mockAdapterHost = {
    httpAdapter: {
      getInstance: jest.fn().mockReturnValue({
        _router: {
          stack: [
            { route: { path: '/auth/login', methods: { post: true } } },
            { route: { path: '/meals/live', methods: { get: true } } },
          ],
        },
      }),
    },
  };

  const mockCacheManager = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
  };

  const mockAppCacheService = {
    getTelemetry: jest.fn().mockReturnValue({
      hits: 0,
      misses: 0,
      sets: 0,
      deletions: 0,
      totalOps: 0,
      hitRatio: 100,
      recentEvents: [],
    }),
    remember: jest.fn((k, ttl, fn) => fn()),
    del: jest.fn(),
    delMany: jest.fn(),
    reset: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SystemService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: HttpAdapterHost, useValue: mockAdapterHost },
        { provide: CACHE_MANAGER, useValue: mockCacheManager },
        { provide: getQueueToken('notification-queue'), useValue: mockQueue },
        {
          provide: AppCacheService,
          useValue: mockAppCacheService,
        },
      ],
    }).compile();

    service = module.get<SystemService>(SystemService);
    jest.clearAllMocks();
  });

  it('should call appCache.reset when clearSystemCache is invoked', async () => {
    const result = await service.clearSystemCache('ALL');
    expect(result.success).toBe(true);
    expect(mockAppCacheService.reset).toHaveBeenCalled();
  });

  it('should return valid system metrics structure', async () => {
    const metrics = await service.getSystemMetrics();

    expect(metrics).toHaveProperty('status', 'OK');
    expect(metrics).toHaveProperty('uptime');
    expect(metrics).toHaveProperty('memory');
    expect(metrics).toHaveProperty('cpu');
    expect(metrics).toHaveProperty('database');
    expect(metrics.database.status).toBe('HEALTHY');
    expect(metrics.queue).toEqual({
      waiting: 0,
      active: 1,
      completed: 10,
      failed: 0,
    });
  });

  it('should format uptime correctly', () => {
    const formatted = (service as any).formatUptime(3661);
    expect(formatted).toBe('0d 1h 1m 1s');
  });
});
