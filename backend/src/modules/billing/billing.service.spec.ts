import { AppCacheService } from '../../common/cache/app-cache.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ContextValidatorService } from '../../common/services/context-validator.service';
import { BillingService } from './billing.service';

describe('BillingService (Unit Tests)', () => {
  let service: BillingService;

  const mockPrismaService: any = {
    monthlyData: {
      create: jest.fn(),
      update: jest.fn(),
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'month_archived', messId: 'mess_1' }),
    },
    mess: { update: jest.fn() },
    bazaarItem: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { cost: 6000 } }),
      count: jest.fn().mockResolvedValue(0),
    },
    dailyLog: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ lunchCount: 60, dinnerCount: 60 }]),
    },
    deposit: {
      groupBy: jest
        .fn()
        .mockResolvedValue([{ userId: 'user_1', _sum: { amount: 2000 } }]),
      count: jest.fn().mockResolvedValue(0),
    },
    mealRequest: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ userId: 'user_1', category: 'GUEST', count: 2 }]),
    },
    user: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'user_1', name: 'Jisan', email: 'j@test.com' },
        ]),
    },
    $transaction: jest.fn((callback) => callback(mockPrismaService)),
  };

  const mockContextValidator = {
    validateUserAndMess: jest.fn().mockResolvedValue({
      user: { id: 'user_1', messId: 'mess_1' },
      mess: { id: 'mess_1', currentMonthId: 'month_1' },
    }),
    validateManager: jest.fn().mockResolvedValue({
      manager: { id: 'user_1', messId: 'mess_1' },
      mess: { id: 'mess_1', isMonthActive: false, currentMonthId: 'month_1' },
    }),
  };

  const mockCacheManager = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ContextValidatorService, useValue: mockContextValidator },
        { provide: CACHE_MANAGER, useValue: mockCacheManager },
        {
          provide: AppCacheService,
          useValue: {
            remember: jest.fn((k, ttl, fn) => fn()),
            del: jest.fn(),
            delMany: jest.fn(),
          },
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = module.get<BillingService>(BillingService);
    jest.clearAllMocks();
  });

  it('should calculate correct meal rate and complete member financial ledger', async () => {
    const result = await service.getMonthSummary('user_1');

    expect(result.totalBazaarCost).toBe(6000);
    expect(result.totalMeals).toBe(120);
    expect(result.mealRate).toBe(50);

    // Verify member individual accounting ledger
    expect(result.members).toHaveLength(1);
    const member = result.members[0];
    expect(member.name).toBe('Jisan');
    expect(member.totalDeposit).toBe(2000);
    expect(member.totalMeals).toBe(4); // 2 default + 2 guest meals
    expect(member.mealCost).toBe(200); // 4 * 50
    expect(member.balance).toBe(1800); // 2000 - 200 = 1800 refund/advance
  });

  it('should fallback to latest closed month when currentMonthId is null', async () => {
    mockContextValidator.validateUserAndMess.mockResolvedValueOnce({
      user: { id: 'user_1', messId: 'mess_1' },
      mess: { id: 'mess_1', currentMonthId: null },
    });

    const result = await service.getMonthSummary('user_1');
    expect(result.monthId).toBe('month_archived');
    expect(mockPrismaService.monthlyData.findFirst).toHaveBeenCalledWith({
      where: { messId: 'mess_1' },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('should prorate default meals fairly when member joins mid-month', async () => {
    mockPrismaService.dailyLog.findMany.mockResolvedValueOnce([
      { id: 'month_1_2026-07-01', lunchCount: 2, dinnerCount: 2 },
      { id: 'month_1_2026-07-02', lunchCount: 2, dinnerCount: 2 },
      { id: 'month_1_2026-07-03', lunchCount: 2, dinnerCount: 2 },
    ]);
    mockPrismaService.user.findMany.mockResolvedValueOnce([
      {
        id: 'user_late',
        name: 'Late Member',
        email: 'late@test.com',
        joinedAt: new Date('2026-07-02T10:00:00+06:00'),
        leftAt: null,
      },
    ]);
    mockPrismaService.mealRequest.findMany.mockResolvedValueOnce([]);
    mockPrismaService.deposit.groupBy.mockResolvedValueOnce([
      { userId: 'user_late', _sum: { amount: 1000 } },
    ]);

    const result = await service.getMonthSummary('user_1');
    const member = result.members[0];
    // 3 days total, but joined on day 2 -> active on day 2 and day 3 = 2 days * 2 = 4 meals (instead of 6 meals)
    expect(member.totalMeals).toBe(4);
  });

  it('should exclude cancelled meals from total meals and default member meals', async () => {
    mockPrismaService.dailyLog.findMany.mockResolvedValueOnce([
      {
        id: 'month_1_2026-07-01',
        lunchCount: 5,
        dinnerCount: 5,
        lunchStatus: 'CANCELLED',
        dinnerStatus: 'OPEN',
      },
    ]);
    mockPrismaService.user.findMany.mockResolvedValueOnce([
      {
        id: 'user_1',
        name: 'Jisan',
        email: 'j@test.com',
        joinedAt: new Date('2026-07-01T00:00:00+06:00'),
        leftAt: null,
      },
    ]);
    mockPrismaService.mealRequest.findMany.mockResolvedValueOnce([]);
    mockPrismaService.deposit.groupBy.mockResolvedValueOnce([]);

    const result = await service.getMonthSummary('user_1');
    // Total meals: lunch was cancelled (0) + dinner (5) = 5
    expect(result.totalMeals).toBe(5);
    // Member default: lunch was cancelled, so only 1 dinner = 1 meal (not 2)
    expect(result.members[0].totalMeals).toBe(1);
  });

  describe('closeMonthSession', () => {
    it('should block closing month if pending bazaar items exist', async () => {
      mockContextValidator.validateManager.mockResolvedValueOnce({
        manager: { id: 'user_1', messId: 'mess_1' },
        mess: { id: 'mess_1', isMonthActive: true, currentMonthId: 'month_1' },
      });
      mockPrismaService.bazaarItem.count.mockResolvedValueOnce(2);
      mockPrismaService.deposit.count.mockResolvedValueOnce(0);

      await expect(service.closeMonthSession('user_1')).rejects.toThrow(
        /Cannot close month: There are 2 pending bazaar items and 0 pending deposits awaiting approval/,
      );
    });

    it('should block closing month if pending deposits exist', async () => {
      mockContextValidator.validateManager.mockResolvedValueOnce({
        manager: { id: 'user_1', messId: 'mess_1' },
        mess: { id: 'mess_1', isMonthActive: true, currentMonthId: 'month_1' },
      });
      mockPrismaService.bazaarItem.count.mockResolvedValueOnce(0);
      mockPrismaService.deposit.count.mockResolvedValueOnce(1);

      await expect(service.closeMonthSession('user_1')).rejects.toThrow(
        /Cannot close month: There are 0 pending bazaar items and 1 pending deposits awaiting approval/,
      );
    });

    it('should successfully close and archive month when no pending items exist', async () => {
      mockContextValidator.validateManager.mockResolvedValueOnce({
        manager: { id: 'user_1', messId: 'mess_1' },
        mess: { id: 'mess_1', isMonthActive: true, currentMonthId: 'month_1' },
      });
      mockPrismaService.bazaarItem.count.mockResolvedValueOnce(0);
      mockPrismaService.deposit.count.mockResolvedValueOnce(0);

      const res = await service.closeMonthSession('user_1');
      expect(res.message).toContain(
        'Month session closed and archived successfully',
      );
      expect(mockPrismaService.monthlyData.update).toHaveBeenCalledWith({
        where: { id: 'month_1' },
        data: { isClosed: true },
      });
    });
  });
});
