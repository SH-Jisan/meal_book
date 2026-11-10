import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SaveFcmTokenDto } from './dto/save-fcm-token.dto';

@Injectable()
export class NotificationService implements OnModuleInit {
  private readonly logger = new Logger(NotificationService.name);
  private firebaseInitialized = false;

  constructor(private prisma: PrismaService) {}

  onModuleInit() {
    try {
      if (!getApps().length) {
        initializeApp();
        this.logger.log('Firebase Admin SDK initialized successfully');
      }
      this.firebaseInitialized = true;
    } catch {
      this.logger.warn(
        'Firebase credentials not configured yet. Push notifications will run in mock/log mode.',
      );
    }
  }

  // ১. ইউজারের FCM টোকেন সেভ বা আপডেট করা
  async saveFcmToken(userId: string, dto: SaveFcmTokenDto) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { fcmToken: dto.fcmToken },
    });
    return { message: 'FCM Token saved successfully' };
  }

  // ২. নির্দিষ্ট ইউজারকে পুশ নোটিফিকেশন পাঠানো এবং ইন-অ্যাপ নোটিফিকেশন হিস্ট্রি সেভ করা
  async sendNotificationToUser(userId: string, title: string, body: string) {
    const notification = await this.prisma.notification.create({
      data: {
        userId,
        title,
        body,
      },
    });

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { fcmToken: true },
    });

    if (user?.fcmToken && this.firebaseInitialized) {
      try {
        await getMessaging().send({
          token: user.fcmToken,
          notification: { title, body },
        });
        this.logger.log(`Push notification sent to user: ${userId}`);
      } catch (err: unknown) {
        this.logger.error(`Failed to send FCM push to user: ${userId}`, err);
      }
    }

    return notification;
  }

  // ৩. মেসের সব মেম্বারদের একসাথে পুশ নোটিফিকেশন পাঠানো (Multicast Send)
  async sendNotificationToMess(messId: string, title: string, body: string) {
    const members = await this.prisma.user.findMany({
      where: { messId },
      select: { id: true, fcmToken: true },
    });

    if (!members.length) return;

    const notificationEntries = members.map((member) => ({
      userId: member.id,
      title,
      body,
    }));

    await this.prisma.notification.createMany({
      data: notificationEntries,
    });

    const tokens = members
      .map((m) => m.fcmToken)
      .filter((t): t is string => Boolean(t));

    if (tokens.length > 0 && this.firebaseInitialized) {
      try {
        const batchSize = 500;
        for (let i = 0; i < tokens.length; i += batchSize) {
          const batchTokens = tokens.slice(i, i + batchSize);
          await getMessaging().sendEachForMulticast({
            tokens: batchTokens,
            notification: { title, body },
          });
        }
        this.logger.log(
          `Multicast push sent to mess: ${messId} (${tokens.length} devices)`,
        );
      } catch (err: unknown) {
        this.logger.error(`Failed multicast push to mess: ${messId}`, err);
      }
    }
  }

  // ৪. মেম্বারের ইন-অ্যাপ নোটিফিকেশন লিস্ট পাওয়া (Bell Icon Dropdown)
  async getUserNotifications(userId: string) {
    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }

  // ৫. ইন-অ্যাপ নোটিফিকেশন Read হিসেবে মার্ক করা
  async markAsRead(notificationId: string, userId: string) {
    return this.prisma.notification.updateMany({
      where: { id: notificationId, userId },
      data: { isRead: true },
    });
  }
}
