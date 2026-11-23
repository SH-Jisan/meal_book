import { BadRequestException } from '@nestjs/common';
import { AppCacheService } from '../../common/cache/app-cache.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ContextValidatorService } from '../../common/services/context-validator.service';
import { MealsService } from './meals.service';
import { MealRequestsService } from './meal-requests.service';
import { MealType, RequestCategory } from './dto/update-meal.dto';
import { MealStatus } from '@prisma/client';

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
      manager: { id: 'mgr_1', messId: 'mess_1' },
      mess: { id: 'mess_1', currentMonthId: 'month_1' },
    }),
  };

  const mockQueue = {
    add: jest.fn().mockResolvedValue({}),
  };

  const mockEventEmitter = {
    emit: jest.fn(),
  };

  const mockAppCache = {
    remember: jest.fn((key, ttl, cb) => cb()),
    del: jest.fn().mockResolvedValue(undefined),
  };

  const mockMealRequestsService = {
    requestMealUpdate: jest.fn().mockResolvedValue({ id: 'req_1' }),
    approveRequest: jest
      .fn()
      .mockResolvedValue({ message: 'Request approved successfully' }),
    rejectRequest: jest
      .fn()
      .mockResolvedValue({ message: 'Request rejected successfully' }),
    getPendingRequests: jest.fn().mockResolvedValue([]),
    cancelMealRequest: jest
      .fn()
      .mockResolvedValue({ message: 'Meal request cancelled successfully' }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MealsService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ContextValidatorService, useValue: mockContextValidator },
        { provide: AppCacheService, useValue: mockAppCache },
        { provide: EventEmitter2, useValue: mockEventEmitter },
        { provide: getQueueToken('notification-queue'), useValue: mockQueue },
        { provide: MealRequestsService, useValue: mockMealRequestsService },
      ],
    }).compile();

    service = module.get<MealsService>(MealsService);
  });

  describe('Delegation to MealRequestsService', () => {
    it('should delegate requestMealUpdate', async () => {
      const res = await service.requestMealUpdate(
        { type: MealType.LUNCH, category: RequestCategory.OFF, count: 1 },
        'user_1',
      );
      expect(res).toHaveProperty('id', 'req_1');
      expect(mockMealRequestsService.requestMealUpdate).toHaveBeenCalled();
    });

    it('should delegate approveRequest', async () => {
      const res = await service.approveRequest('req_1', 'mgr_1');
      expect(res.message).toBe('Request approved successfully');
      expect(mockMealRequestsService.approveRequest).toHaveBeenCalledWith(
        'req_1',
        'mgr_1',
      );
    });

    it('should delegate rejectRequest', async () => {
      const res = await service.rejectRequest('req_1', 'mgr_1');
      expect(res.message).toBe('Request rejected successfully');
      expect(mockMealRequestsService.rejectRequest).toHaveBeenCalledWith(
        'req_1',
        'mgr_1',
      );
    });

    it('should delegate getPendingRequests', async () => {
      const res = await service.getPendingRequests('mgr_1');
      expect(res).toEqual([]);
      expect(mockMealRequestsService.getPendingRequests).toHaveBeenCalledWith(
        'mgr_1',
      );
    });

    it('should delegate cancelMealRequest', async () => {
      const res = await service.cancelMealRequest('req_1', 'user_1');
      expect(res.message).toBe('Meal request cancelled successfully');
      expect(mockMealRequestsService.cancelMealRequest).toHaveBeenCalledWith(
        'req_1',
        'user_1',
      );
    });
  });

  describe('updateMealStatus', () => {
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

    it('should reset count to 0 and record manager name when status is CANCELLED', async () => {
      mockContextValidator.validateManager.mockResolvedValueOnce({
        manager: { id: 'mgr_1', name: 'Tareq', messId: 'mess_1' },
        mess: { id: 'mess_1', currentMonthId: 'month_1' },
      });

      await service.updateMealStatus(
        { type: MealType.LUNCH, status: MealStatus.CANCELLED },
        'mgr_1',
      );

      expect(mockPrismaService.dailyLog.update).toHaveBeenCalledWith({
        where: { id: '2026-07-23' },
        data: {
          lunchStatus: MealStatus.CANCELLED,
          lunchCancelledBy: 'Tareq',
          lunchCount: 0,
        },
      });
    });
  });

  describe('getDailyLiveCount', () => {
    it('should return today daily live count and cached log', async () => {
      mockPrismaService.dailyLog.findUnique.mockResolvedValueOnce({
        id: 'month_1_2026-07-23',
        lunchCount: 4,
        dinnerCount: 5,
        requests: [],
      });

      const res = await service.getDailyLiveCount('user_1');
      expect(res).toHaveProperty('lunchCount', 4);
      expect(mockAppCache.remember).toHaveBeenCalled();
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
        service.getDailyLogByDate('invalid-date', 'user_1'),
      ).rejects.toThrow(
        new BadRequestException('Invalid date format. Expected YYYY-MM-DD'),
      );
    });
  });
});
