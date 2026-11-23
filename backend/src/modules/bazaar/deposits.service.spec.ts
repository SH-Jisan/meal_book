import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ContextValidatorService } from '../../common/services/context-validator.service';
import { AppCacheService } from '../../common/cache/app-cache.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DepositsService } from './deposits.service';

describe('DepositsService (Unit Tests)', () => {
  let service: DepositsService;

  const mockPrismaService: any = {
    deposit: {
      create: jest.fn().mockImplementation(({ data }) =>
        Promise.resolve({
          id: 'dep_' + Math.random().toString(36).substring(2, 6),
          ...data,
        }),
      ),
      update: jest.fn().mockResolvedValue({ id: 'dep_1', status: 'APPROVED' }),
      findMany: jest.fn().mockResolvedValue([]),
      findUniqueOrThrow: jest.fn(),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'manager_1',
        name: 'Manager',
        messId: 'mess_1',
      }),
    },
  };

  const mockContextValidator = {
    validateManager: jest.fn().mockResolvedValue({
      manager: { id: 'manager_1', messId: 'mess_1' },
      mess: { id: 'mess_1', isMonthActive: true, currentMonthId: 'month_1' },
    }),
    validateUserAndMess: jest.fn().mockResolvedValue({
      user: { id: 'user_1', messId: 'mess_1', name: 'User 1' },
      mess: { id: 'mess_1', currentMonthId: 'month_1' },
    }),
    validateUserMessAndActiveMonth: jest.fn().mockResolvedValue({
      user: { id: 'user_1', name: 'User 1', messId: 'mess_1' },
      mess: { id: 'mess_1', managerId: 'manager_1' },
      activeMonthId: 'month_1',
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

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DepositsService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ContextValidatorService, useValue: mockContextValidator },
        { provide: AppCacheService, useValue: mockAppCache },
        { provide: EventEmitter2, useValue: mockEventEmitter },
        { provide: getQueueToken('notification-queue'), useValue: mockQueue },
      ],
    }).compile();

    service = module.get<DepositsService>(DepositsService);
  });

  describe('addDeposit', () => {
    it('should log deposit successfully when called by manager', async () => {
      mockPrismaService.user.findUnique.mockResolvedValueOnce({
        id: 'user_1',
        messId: 'mess_1',
      });
      mockPrismaService.deposit.create.mockResolvedValueOnce({
        id: 'dep_1',
        userId: 'user_1',
        amount: 500,
        status: 'APPROVED',
      });

      const res = await service.addDeposit(
        { userId: 'user_1', amount: 500 },
        'manager_1',
      );

      expect(res.amount).toBe(500);
      expect(mockPrismaService.deposit.create).toHaveBeenCalledWith({
        data: {
          monthId: 'month_1',
          userId: 'user_1',
          amount: 500,
          status: 'APPROVED',
        },
      });
      expect(mockEventEmitter.emit).toHaveBeenCalled();
      expect(mockQueue.add).toHaveBeenCalledWith('send-user-notification', {
        userId: 'user_1',
        title: '💳 Deposit Logged!',
        body: expect.stringContaining('500'),
      });
    });

    it('should throw BadRequestException if target user is not in the same mess', async () => {
      mockPrismaService.user.findUnique.mockResolvedValueOnce({
        id: 'user_2',
        messId: 'other_mess',
      });

      await expect(
        service.addDeposit({ userId: 'user_2', amount: 500 }, 'manager_1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('submitDepositRequest', () => {
    it('should allow member to submit standalone deposit request', async () => {
      mockPrismaService.deposit.create.mockResolvedValueOnce({
        id: 'dep_new',
        amount: 2000,
        status: 'PENDING_APPROVAL',
      });
      mockPrismaService.user.findUnique.mockResolvedValueOnce({
        id: 'manager_1',
        name: 'Manager',
      });

      const res = await service.submitDepositRequest(
        { amount: 2000, note: 'bKash TrxID #9X8' },
        'user_1',
      );

      expect(res.message).toContain('pending manager approval');
      expect(mockPrismaService.deposit.create).toHaveBeenCalledWith({
        data: {
          monthId: 'month_1',
          userId: 'user_1',
          amount: 2000,
          status: 'PENDING_APPROVAL',
        },
      });
      expect(mockQueue.add).toHaveBeenCalledWith('send-user-notification', {
        userId: 'manager_1',
        title: '💳 New Deposit Request',
        body: expect.stringContaining('2000'),
      });
    });
  });

  describe('approveDeposit', () => {
    it('should allow manager to approve standalone deposit', async () => {
      mockPrismaService.deposit.findUniqueOrThrow.mockResolvedValueOnce({
        id: 'dep_1',
        userId: 'user_1',
        amount: 2000,
        status: 'PENDING_APPROVAL',
        monthId: 'month_1',
        month: { messId: 'mess_1' },
      });
      mockPrismaService.deposit.update.mockResolvedValueOnce({
        id: 'dep_1',
        status: 'APPROVED',
      });

      const res = await service.approveDeposit('dep_1', 'manager_1');
      expect(res.status).toBe('APPROVED');
      expect(mockPrismaService.deposit.update).toHaveBeenCalledWith({
        where: { id: 'dep_1' },
        data: { status: 'APPROVED' },
      });
      expect(mockQueue.add).toHaveBeenCalledWith('send-user-notification', {
        userId: 'user_1',
        title: '✅ Deposit Approved!',
        body: expect.stringContaining('2000'),
      });
    });

    it('should throw ForbiddenException if deposit belongs to another mess', async () => {
      mockPrismaService.deposit.findUniqueOrThrow.mockResolvedValueOnce({
        id: 'dep_1',
        month: { messId: 'other_mess' },
        status: 'PENDING_APPROVAL',
      });

      await expect(
        service.approveDeposit('dep_1', 'manager_1'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('rejectDeposit', () => {
    it('should allow manager to reject standalone deposit', async () => {
      mockPrismaService.deposit.findUniqueOrThrow.mockResolvedValueOnce({
        id: 'dep_1',
        userId: 'user_1',
        amount: 2000,
        status: 'PENDING_APPROVAL',
        monthId: 'month_1',
        month: { messId: 'mess_1' },
      });
      mockPrismaService.deposit.update.mockResolvedValueOnce({
        id: 'dep_1',
        status: 'REJECTED',
      });

      const res = await service.rejectDeposit('dep_1', 'manager_1');
      expect(res.status).toBe('REJECTED');
      expect(mockPrismaService.deposit.update).toHaveBeenCalledWith({
        where: { id: 'dep_1' },
        data: { status: 'REJECTED' },
      });
      expect(mockQueue.add).toHaveBeenCalledWith('send-user-notification', {
        userId: 'user_1',
        title: '❌ Deposit Rejected',
        body: expect.stringContaining('2000'),
      });
    });
  });

  describe('getDeposits', () => {
    it('should return deposits list for current month', async () => {
      mockPrismaService.deposit.findMany.mockResolvedValueOnce([
        {
          id: 'dep_1',
          amount: 1500,
          status: 'APPROVED',
          user: { name: 'Jisan' },
        },
      ]);

      const deposits = await service.getDeposits('user_1');
      expect(deposits).toHaveLength(1);
      expect(deposits[0].amount).toBe(1500);
      expect(mockPrismaService.deposit.findMany).toHaveBeenCalled();
    });
  });
});
