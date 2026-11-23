import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ContextValidatorService } from '../../common/services/context-validator.service';
import { MessService } from './mess.service';
import { AppCacheService } from '../../common/cache/app-cache.service';
import { EventEmitter2 } from '@nestjs/event-emitter';

describe('MessService (Unit Tests)', () => {
  let service: MessService;

  const mockPrismaService: any = {
    mess: {
      create: jest.fn().mockResolvedValue({
        id: 'mess_123',
        name: 'Dream Mess',
        code: '4921',
      }),
      findUnique: jest.fn(),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'user_1',
        messId: null,
        email: 'test@test.com',
      }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: 'user_1',
        messId: null,
        email: 'test@test.com',
      }),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },

    $transaction: jest.fn((callback) => callback(mockPrismaService)),
  };

  const mockContextValidator = {
    validateUserHasNoMess: jest.fn().mockResolvedValue(true),
    validateUserAndMess: jest.fn().mockResolvedValue({
      user: { id: 'user_1', messId: 'mess_123' },
      mess: { id: 'mess_123' },
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
        MessService,
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
        {
          provide: getQueueToken('notification-queue'),
          useValue: { add: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get<MessService>(MessService);
  });

  it('should create a mess and assign 4-digit code', async () => {
    const result = await service.createMess({ name: 'Dream Mess' }, 'user_123');

    expect(result).toHaveProperty('mess');
    expect(result.mess).toHaveProperty('code');
    expect(result.mess.name).toBe('Dream Mess');
  });

  it('should return current mess details', async () => {
    mockPrismaService.user.count = jest.fn().mockResolvedValue(5);
    const result = await service.getMessDetails('user_1');

    expect(result).toHaveProperty('id', 'mess_123');
    expect(result).toHaveProperty('memberCount', 5);
  });

  it('should update mess settings by manager', async () => {
    mockContextValidator.validateManager = jest.fn().mockResolvedValue({
      manager: { id: 'mgr_1', messId: 'mess_123', name: 'Manager' },
      mess: { id: 'mess_123', currentMonthId: 'month_1' },
    });
    mockPrismaService.mess.update = jest.fn().mockResolvedValue({
      id: 'mess_123',
      name: 'New Name',
      lunchEndTime: '11:30',
      dinnerEndTime: '18:00',
    });

    const result = await service.updateMessSettings(
      { name: 'New Name', lunchEndTime: '11:30', dinnerEndTime: '18:00' },
      'mgr_1',
    );

    expect(result.mess.name).toBe('New Name');
    expect(result.mess.lunchEndTime).toBe('11:30');
  });

  it('should allow manager to remove a member', async () => {
    mockContextValidator.validateManager = jest.fn().mockResolvedValue({
      manager: { id: 'mgr_1', messId: 'mess_123', name: 'Manager' },
      mess: { id: 'mess_123', currentMonthId: 'month_1', name: 'Dream Mess' },
    });
    mockPrismaService.user.findUnique = jest.fn().mockResolvedValue({
      id: 'member_2',
      name: 'Bad Member',
      email: 'bad@test.com',
      messId: 'mess_123',
    });
    mockPrismaService.user.update = jest.fn().mockResolvedValue({});

    const result = await service.removeMember('member_2', 'mgr_1');

    expect(result.message).toContain('successfully removed');
    expect(mockPrismaService.user.update).toHaveBeenCalledWith({
      where: { id: 'member_2' },
      data: expect.objectContaining({ messId: null }),
    });
  });
});
