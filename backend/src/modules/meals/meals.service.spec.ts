import { BadRequestException } from '@nestjs/common';
import { AppCacheService } from '../../common/cache/app-cache.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ContextValidatorService } from '../../common/services/context-validator.service';
import { MealsService } from './meals.service';
import { MealType, RequestCategory } from './dto/update-meal.dto';
import { MealStatus, RequestStatus } from '@prisma/client';

describe('MealsService (Unit Tests)', () => {
  let service: MealsService;

  const mockPrismaService: any = {
    dailyLog: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: '2026-07-23', monthId: 'month_1' }),
      findFirst: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({
        id: '2026-07-23',
        monthId: 'month_1',
        lunchStatus: MealStatus.OPEN,
        dinnerStatus: MealStatus.OPEN,
      }),
      update: jest.fn().mockResolvedValue({ id: '2026-07-23' }),
    },
    user: {
      count: jest.fn().mockResolvedValue(5),
    },
    mealRequest: {
      create: jest.fn().mockResolvedValue({ id: 'req_1', status: 'PENDING' }),
      findFirst: jest.fn().mockResolvedValue(null),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: 'req_1',
        status: RequestStatus.PENDING,
        type: 'LUNCH',
        category: 'OFF',
        count: 1,
        userId: 'user_1',
        logId: '2026-07-23',
        user: { messId: 'mess_1' },
      }),
      update: jest.fn().mockResolvedValue({ id: 'req_1' }),
      delete: jest.fn().mockResolvedValue({ id: 'req_1' }),
    },
    $transaction: jest.fn((callback) => callback(mockPrismaService)),
  };

  const mockContextValidator = {
    validateUserMessAndActiveMonth: jest.fn().mockResolvedValue({
      user: { id: 'user_1' },
      mess: { id: 'mess_1', lunchEndTime: '23:59', dinnerEndTime: '23:59' },
      activeMonthId: 'month_1',
    }),
    validateUserAndMess: jest.fn().mockResolvedValue({
      user: { id: 'user_1', messId: 'mess_1' },
      mess: {
        id: 'mess_1',
        currentMonthId: 'month_1',
        lunchEndTime: '23:59',
        dinnerEndTime: '23:59',
      },
    }),
    validateManager: jest.fn().mockResolvedValue({
      manager: { id: 'mgr_1', messId: 'mess_1', name: 'Manager' },
      mess: {
        id: 'mess_1',
        currentMonthId: 'month_1',
        lunchEndTime: '23:59',
        dinnerEndTime: '23:59',
      },
    }),
  };

  const mockCacheManager = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
  };

  const mockQueue = {
    add: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MealsService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ContextValidatorService, useValue: mockContextValidator },
        { provide: CACHE_MANAGER, useValue: mockCacheManager },
        { provide: getQueueToken('notification-queue'), useValue: mockQueue },
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

    service = module.get<MealsService>(MealsService);
    jest.clearAllMocks();
  });

  it('should submit meal request successfully', async () => {
    const result = await service.requestMealUpdate(
      { type: MealType.LUNCH, category: RequestCategory.OFF, count: 1 },
      'user_1',
    );

    expect(result).toHaveProperty('id', 'req_1');
    expect(result).toHaveProperty('status', 'PENDING');
    expect(mockPrismaService.dailyLog.upsert).toHaveBeenCalled();
  });

  it('should reject request when deadline has passed in Asia/Dhaka time', async () => {
    mockContextValidator.validateUserMessAndActiveMonth.mockResolvedValueOnce({
      user: { id: 'user_1' },
      mess: { id: 'mess_1', lunchEndTime: '00:00' }, // 00:00 is passed at any hour > 0
      activeMonthId: 'month_1',
    });

    await expect(
      service.requestMealUpdate(
        { type: MealType.LUNCH, category: RequestCategory.OFF, count: 1 },
        'user_1',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('should reject OFF request if count is greater than 1', async () => {
    await expect(
      service.requestMealUpdate(
        { type: MealType.LUNCH, category: RequestCategory.OFF, count: 2 },
        'user_1',
      ),
    ).rejects.toThrow(
      new BadRequestException('For turning meal OFF, count must be exactly 1.'),
    );
  });

  it('should reject OFF request if duplicate active request exists for same day and meal', async () => {
    mockPrismaService.mealRequest.findFirst.mockResolvedValueOnce({
      id: 'existing_req',
    });

    await expect(
      service.requestMealUpdate(
        { type: MealType.LUNCH, category: RequestCategory.OFF, count: 1 },
        'user_1',
      ),
    ).rejects.toThrow(
      new BadRequestException(
        'You already have an active or approved OFF request for lunch today.',
      ),
    );
  });

  it('should reject meal modification if meal is already COOKING', async () => {
    mockPrismaService.dailyLog.upsert.mockResolvedValueOnce({
      id: '2026-07-23',
      monthId: 'month_1',
      lunchStatus: MealStatus.COOKING,
      dinnerStatus: MealStatus.OPEN,
    });

    await expect(
      service.requestMealUpdate(
        { type: MealType.LUNCH, category: RequestCategory.OFF, count: 1 },
        'user_1',
      ),
    ).rejects.toThrow(
      new BadRequestException('Cannot modify meal: lunch is already cooking!'),
    );
  });

  it('should allow manager to reject a pending meal request', async () => {
    const result = await service.rejectRequest('req_1', 'mgr_1');

    expect(result).toHaveProperty('message', 'Request rejected successfully');
    expect(mockPrismaService.mealRequest.update).toHaveBeenCalledWith({
      where: { id: 'req_1' },
      data: { status: RequestStatus.REJECTED },
    });
    expect(mockQueue.add).toHaveBeenCalledWith('send-user-notification', {
      userId: 'user_1',
      title: '❌ Meal Request Rejected',
      body: 'Manager rejected your OFF request for LUNCH.',
    });
  });

  it('should allow manager to update today meal cooking status', async () => {
    const result = await service.updateMealStatus(
      { type: MealType.LUNCH, status: MealStatus.COOKING },
      'mgr_1',
    );

    expect(result.message).toContain(
      'LUNCH status successfully updated to COOKING',
    );
    expect(mockPrismaService.dailyLog.update).toHaveBeenCalledWith({
      where: { id: '2026-07-23' },
      data: { lunchStatus: MealStatus.COOKING },
    });
    expect(mockQueue.add).toHaveBeenCalledWith('send-mess-notification', {
      messId: 'mess_1',
      title: '🍲 Meal Status Update: LUNCH',
      body: 'LUNCH is now marked as COOKING by Manager.',
    });
  });

  describe('cancelMealRequest', () => {
    it('should successfully cancel pending meal request before deadline', async () => {
      mockPrismaService.mealRequest.findUniqueOrThrow.mockResolvedValueOnce({
        id: 'req_1',
        userId: 'user_1',
        type: 'LUNCH',
        status: RequestStatus.PENDING,
      });

      const res = await service.cancelMealRequest('req_1', 'user_1');
      expect(res.message).toBe('Meal request cancelled successfully');
      expect(mockPrismaService.mealRequest.delete).toHaveBeenCalledWith({
        where: { id: 'req_1' },
      });
    });

    it('should reject cancellation if request belongs to someone else', async () => {
      mockPrismaService.mealRequest.findUniqueOrThrow.mockResolvedValueOnce({
        id: 'req_1',
        userId: 'other_user',
        type: 'LUNCH',
        status: RequestStatus.PENDING,
      });

      await expect(
        service.cancelMealRequest('req_1', 'user_1'),
      ).rejects.toThrow(
        new BadRequestException('You can only cancel your own meal requests.'),
      );
    });

    it('should reject cancellation if request is not PENDING', async () => {
      mockPrismaService.mealRequest.findUniqueOrThrow.mockResolvedValueOnce({
        id: 'req_1',
        userId: 'user_1',
        type: 'LUNCH',
        status: RequestStatus.APPROVED,
      });

      await expect(
        service.cancelMealRequest('req_1', 'user_1'),
      ).rejects.toThrow(
        new BadRequestException('Only pending requests can be cancelled.'),
      );
    });

    it('should reject cancellation if deadline has passed', async () => {
      mockContextValidator.validateUserAndMess.mockResolvedValueOnce({
        user: { id: 'user_1', messId: 'mess_1' },
        mess: {
          id: 'mess_1',
          currentMonthId: 'month_1',
          lunchEndTime: '00:00',
        },
      });
      mockPrismaService.mealRequest.findUniqueOrThrow.mockResolvedValueOnce({
        id: 'req_1',
        userId: 'user_1',
        type: 'LUNCH',
        status: RequestStatus.PENDING,
      });

      await expect(
        service.cancelMealRequest('req_1', 'user_1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getDailyLogByDate', () => {
    it('should return log for valid date', async () => {
      mockPrismaService.dailyLog.findUnique.mockResolvedValueOnce({
        id: 'month_1_2026-07-20',
        lunchCount: 10,
        dinnerCount: 10,
        requests: [],
      });

      const res = await service.getDailyLogByDate('2026-07-20', 'user_1');
      expect(res).toHaveProperty('id', 'month_1_2026-07-20');
    });

    it('should reject invalid date format', async () => {
      await expect(
        service.getDailyLogByDate('20-07-2026', 'user_1'),
      ).rejects.toThrow(
        new BadRequestException('Invalid date format. Expected YYYY-MM-DD'),
      );
    });
  });

  describe('getPendingRequests', () => {
    it('should return pending requests for manager active month', async () => {
      mockPrismaService.mealRequest.findMany = jest.fn().mockResolvedValueOnce([
        {
          id: 'req_1',
          status: RequestStatus.PENDING,
          type: 'LUNCH',
          user: { name: 'Rafi' },
        },
      ]);

      const res = await service.getPendingRequests('mgr_1');
      expect(res).toHaveLength(1);
      expect(mockPrismaService.mealRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            log: { monthId: 'month_1' },
            status: RequestStatus.PENDING,
          },
        }),
      );
    });
  });

  it('should reset lunchCount to 0 when meal is CANCELLED', async () => {
    mockPrismaService.dailyLog.update.mockResolvedValueOnce({
      id: '2026-07-23',
      lunchStatus: MealStatus.CANCELLED,
      lunchCount: 0,
    });

    await service.updateMealStatus(
      { type: MealType.LUNCH, status: MealStatus.CANCELLED },
      'mgr_1',
    );

    expect(mockPrismaService.dailyLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lunchStatus: MealStatus.CANCELLED,
          lunchCount: 0,
        }),
      }),
    );
  });

  describe('approveRequest (Edge Cases)', () => {
    it('should reject request approval if meal is CANCELLED', async () => {
      mockPrismaService.mealRequest.findUniqueOrThrow.mockResolvedValueOnce({
        id: 'req_1',
        status: RequestStatus.PENDING,
        type: 'LUNCH',
        category: 'OFF',
        count: 1,
        userId: 'user_1',
        logId: '2026-07-23',
        log: {
          lunchStatus: MealStatus.CANCELLED,
          dinnerStatus: MealStatus.OPEN,
        },
        user: { messId: 'mess_1' },
      });

      await expect(service.approveRequest('req_1', 'mgr_1')).rejects.toThrow(
        new BadRequestException(
          'Cannot approve request: lunch has been cancelled for this day.',
        ),
      );
    });

    it('should floor count at 0 when decrement exceeds current count', async () => {
      mockPrismaService.mealRequest.findUniqueOrThrow.mockResolvedValueOnce({
        id: 'req_1',
        status: RequestStatus.PENDING,
        type: 'LUNCH',
        category: 'OFF',
        count: 5,
        userId: 'user_1',
        logId: '2026-07-23',
        log: { lunchStatus: MealStatus.OPEN, lunchCount: 2 },
        user: { messId: 'mess_1' },
      });

      await service.approveRequest('req_1', 'mgr_1');

      expect(mockPrismaService.dailyLog.update).toHaveBeenCalledWith({
        where: { id: '2026-07-23' },
        data: { lunchCount: 0 }, // Math.max(0, 2 - 5) = 0
      });
    });
  });

  describe('cancelMealRequest (Edge Cases)', () => {
    it('should reject request cancellation if meal is already COOKING', async () => {
      mockPrismaService.mealRequest.findUniqueOrThrow.mockResolvedValueOnce({
        id: 'req_1',
        userId: 'user_1',
        type: 'LUNCH',
        status: RequestStatus.PENDING,
        log: { lunchStatus: MealStatus.COOKING },
      });

      await expect(
        service.cancelMealRequest('req_1', 'user_1'),
      ).rejects.toThrow(
        new BadRequestException(
          'Cannot cancel request: lunch is already cooking!',
        ),
      );
    });
  });
});
