import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { RequestStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ContextValidatorService } from '../../common/services/context-validator.service';
import { UpdateMealDto } from './dto/update-meal.dto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AppCacheService } from '../../common/cache/app-cache.service';
import { CacheKeys } from '../../common/cache/cache-keys';
import { CacheEvents } from '../../common/cache/cache-events.enum';

@Injectable()
export class MealsService {
  constructor(
    private prisma: PrismaService,
    private validator: ContextValidatorService,
    private appCache: AppCacheService,
    private eventEmitter: EventEmitter2,
    @InjectQueue('notification-queue') private notificationQueue: Queue,
  ) {}

  async requestMealUpdate(dto: UpdateMealDto, userId: string) {
    const { mess, activeMonthId } =
      await this.validator.validateUserMessAndActiveMonth(userId);
    const todayStr = new Date().toISOString().split('T')[0];

    const log = await this.getOrCreateDailyLog(
      activeMonthId,
      todayStr,
      mess.id,
    );
    this.checkDeadline(mess, dto.type);

    return this.prisma.mealRequest.create({
      data: {
        logId: log.id,
        userId,
        type: dto.type,
        category: dto.category,
        count: dto.count,
        status: RequestStatus.PENDING,
      },
    });
  }

  async approveRequest(requestId: string, managerId: string) {
    const { manager } = await this.validator.validateManager(managerId);

    const { result, targetUserId, mealType, mealCategory } =
      await this.prisma.$transaction(async (tx) => {
        const request = await tx.mealRequest.findUniqueOrThrow({
          where: { id: requestId },
          include: { log: true, user: true },
        });

        if (request.status !== RequestStatus.PENDING) {
          throw new BadRequestException(
            'This request has already been processed',
          );
        }

        if (request.user.messId !== manager.messId) {
          throw new BadRequestException(
            'Access denied. Member belongs to another mess.',
          );
        }

        await tx.mealRequest.update({
          where: { id: requestId },
          data: { status: RequestStatus.APPROVED },
        });

        const countField =
          request.type === 'LUNCH' ? 'lunchCount' : 'dinnerCount';
        const incrementValue =
          request.category === 'OFF' ? -request.count : request.count;

        await tx.dailyLog.update({
          where: { id: request.logId },
          data: {
            [countField]: {
              increment: incrementValue,
            },
          },
        });

        return {
          result: { message: 'Request approved successfully' },
          targetUserId: request.userId,
          mealType: request.type,
          mealCategory: request.category,
        };
      });

    // 🔴 Invalidation: আজকের লাইভ মিলের ক্যাশ মুছে দেওয়া
    // 📡 Event-Driven Cache Invalidation
    const todayStr = new Date().toISOString().split('T')[0];
    this.eventEmitter.emit(CacheEvents.MEAL_UPDATED, {
      messId: manager.messId!,
      dateStr: todayStr,
    });

    // ⚡ BACKGROUND QUEUE: মেম্বারের ফোনে ব্যাকগ্রাউন্ড পুশ নোটিফিকেশন জব পুশ করা
    await this.notificationQueue.add('send-user-notification', {
      userId: targetUserId,
      title: '🍲 Meal Request Approved!',
      body: `Manager approved your ${mealCategory} request for ${mealType}.`,
    });

    return result;
  }

  async getDailyLiveCount(userId: string) {
    const { user, mess } = await this.validator.validateUserAndMess(userId);
    if (!mess.currentMonthId) return { message: 'No active month session' };

    const todayStr = new Date().toISOString().split('T')[0];
    const logId = `${mess.currentMonthId}_${todayStr}`;
    const cacheKey = CacheKeys.dailyMealLog(user.messId!, todayStr);

    return this.appCache.remember(cacheKey, 300, async () => {
      const log = await this.prisma.dailyLog.findUnique({
        where: { id: logId },
        include: {
          requests: {
            include: {
              user: { select: { name: true, role: true } },
            },
          },
        },
      });
      return log || { message: 'No meal record initialized for today yet.' };
    });
  }

  private async getOrCreateDailyLog(
    monthId: string,
    dateStr: string,
    messId: string,
  ) {
    const logId = `${monthId}_${dateStr}`;
    let log = await this.prisma.dailyLog.findUnique({ where: { id: logId } });

    if (!log) {
      const memberCount = await this.prisma.user.count({
        where: { messId, leftAt: null },
      });
      log = await this.prisma.dailyLog.create({
        data: {
          id: logId,
          monthId,
          lunchCount: memberCount,
          dinnerCount: memberCount,
        },
      });
    }
    return log;
  }

  private checkDeadline(
    mess: { lunchEndTime?: string | null; dinnerEndTime?: string | null },
    type: string,
  ) {
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    const deadlineString =
      (type === 'LUNCH' ? mess.lunchEndTime : mess.dinnerEndTime) || '00:00';
    const [deadHour, deadMin] = deadlineString.split(':').map(Number);

    if (
      currentHour > deadHour ||
      (currentHour === deadHour && currentMinute >= deadMin)
    ) {
      throw new BadRequestException(
        `${type} deadline has passed. Modifications are locked.`,
      );
    }
  }
}
