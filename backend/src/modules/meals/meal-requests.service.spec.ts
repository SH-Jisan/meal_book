import { BadRequestException } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ContextValidatorService } from '../../common/services/context-validator.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MealRequestsService } from './meal-requests.service';
import { MealType, RequestCategory } from './dto/update-meal.dto';
import { MealStatus, RequestStatus } from '@prisma/client';

describe('MealRequestsService (Unit Tests)', () => {
  let service: MealRequestsService;

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
      findMany: jest.fn().mockResolvedValue([]),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: 'req_1',
        status: RequestStatus.PENDING,
        type: 'LUNCH',
        category: 'OFF',
        count: 1,
        userId: 'user_1',
        logId: '2026-07-23',
        user: { messId: 'mess_1' },
        log: { lunchStatus: MealStatus.OPEN, dinnerStatus: MealStatus.OPEN },
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

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MealRequestsService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ContextValidatorService, useValue: mockContextValidator },
        { provide: EventEmitter2, useValue: mockEventEmitter },
        { provide: getQueueToken('notification-queue'), useValue: mockQueue },
      ],
    }).compile();

    service = module.get<MealRequestsService>(MealRequestsService);
  });

  describe('requestMealUpdate', () => {
    it('should submit an OFF meal request successfully', async () => {
      const result = await service.requestMealUpdate(
        { type: MealType.LUNCH, category: RequestCategory.OFF, count: 1 },
        'user_1',
      );

      expect(result).toHaveProperty('id', 'req_1');
      expect(mockPrismaService.mealRequest.create).toHaveBeenCalled();
    });

    it('should reject OFF meal request if count is not 1', async () => {
      await expect(
        service.requestMealUpdate(
          { type: MealType.LUNCH, category: RequestCategory.OFF, count: 2 },
          'user_1',
        ),
      ).rejects.toThrow(
        new BadRequestException(
          'For turning meal OFF, count must be exactly 1.',
        ),
      );
    });

    it('should reject duplicate OFF request if one already exists', async () => {
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
        new BadRequestException(
          'Cannot modify meal: lunch is already cooking!',
        ),
      );
    });
  });

  describe('approveRequest', () => {
    it('should allow manager to approve a pending meal request', async () => {
      const result = await service.approveRequest('req_1', 'mgr_1');

      expect(result).toHaveProperty('message', 'Request approved successfully');
      expect(mockPrismaService.mealRequest.update).toHaveBeenCalledWith({
        where: { id: 'req_1' },
        data: { status: RequestStatus.APPROVED },
      });
      expect(mockQueue.add).toHaveBeenCalledWith('send-user-notification', {
        userId: 'user_1',
        title: '🍲 Meal Request Approved!',
        body: expect.stringContaining('approved'),
      });
    });
  });

  describe('rejectRequest', () => {
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
        body: expect.stringContaining('rejected'),
      });
    });
  });

  describe('cancelMealRequest', () => {
    it('should successfully cancel pending meal request before deadline', async () => {
      mockPrismaService.mealRequest.findUniqueOrThrow.mockResolvedValueOnce({
        id: 'req_1',
        userId: 'user_1',
        type: 'LUNCH',
        status: RequestStatus.PENDING,
        log: { lunchStatus: MealStatus.OPEN },
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
        log: { lunchStatus: MealStatus.OPEN },
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
        log: { lunchStatus: MealStatus.OPEN },
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
        log: { lunchStatus: MealStatus.OPEN },
      });

      await expect(
        service.cancelMealRequest('req_1', 'user_1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getPendingRequests', () => {
    it('should return pending requests for current month', async () => {
      mockPrismaService.mealRequest.findMany.mockResolvedValueOnce([
        { id: 'req_1', status: RequestStatus.PENDING },
      ]);

      const res = await service.getPendingRequests('mgr_1');
      expect(res).toHaveLength(1);
      expect(mockPrismaService.mealRequest.findMany).toHaveBeenCalled();
    });
  });
});
