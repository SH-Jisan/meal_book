import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationService } from './notification.service';

describe('NotificationService (Unit Tests)', () => {
  let service: NotificationService;

  const mockPrismaService = {
    user: {
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'user_1', fcmToken: 'token_1' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    notification: {
      create: jest.fn().mockResolvedValue({
        id: 'notif_1',
        title: 'Meal Status',
        body: 'Meal turned OFF',
      }),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(3),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<NotificationService>(NotificationService);
  });

  it('should save FCM token successfully', async () => {
    const response = await service.saveFcmToken('user_123', {
      fcmToken: 'sample_token',
    });

    expect(response).toEqual({ message: 'FCM Token saved successfully' });
  });

  it('should create notification entry for user', async () => {
    const notif = await service.sendNotificationToUser(
      'user_123',
      'Test Title',
      'Test Body',
    );

    expect(notif).toHaveProperty('id', 'notif_1');
  });

  it('should mark all notifications as read', async () => {
    mockPrismaService.notification.updateMany.mockResolvedValueOnce({
      count: 5,
    });
    const result = await service.markAllAsRead('user_123');

    expect(result).toHaveProperty('count', 5);
    expect(mockPrismaService.notification.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user_123', isRead: false },
      data: { isRead: true },
    });
  });

  it('should return unread notification count', async () => {
    mockPrismaService.notification.count = jest.fn().mockResolvedValueOnce(3);
    const result = await service.getUnreadCount('user_123');

    expect(result).toEqual({ unreadCount: 3 });
    expect(mockPrismaService.notification.count).toHaveBeenCalledWith({
      where: { userId: 'user_123', isRead: false },
    });
  });

  it('should paginate notifications with limit and offset', async () => {
    mockPrismaService.notification.findMany.mockResolvedValueOnce([
      { id: 'notif_1', title: 'Test 1' },
    ]);

    const result = await service.getUserNotifications('user_123', 10, 5);
    expect(result).toHaveLength(1);
    expect(mockPrismaService.notification.findMany).toHaveBeenCalledWith({
      where: { userId: 'user_123' },
      orderBy: { createdAt: 'desc' },
      take: 10,
      skip: 5,
    });
  });
});
