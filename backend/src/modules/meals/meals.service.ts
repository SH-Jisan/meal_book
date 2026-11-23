import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { MealStatus, RequestStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ContextValidatorService } from '../../common/services/context-validator.service';
import {
  MealType,
  RequestCategory,
  UpdateMealDto,
} from './dto/update-meal.dto';
import { UpdateMealStatusDto } from './dto/update-meal-status.dto';
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
    const todayStr = this.getDhakaDate();

    const log = await this.getOrCreateDailyLog(
      activeMonthId,
      todayStr,
      mess.id,
    );
    this.checkDeadline(mess, dto.type);

    // 🔒 1. Cooking status barrier: রান্না শুরু হয়ে গেলে বা বাতিল হলে মডিফাই করা যাবে না
    const mealStatus =
      dto.type === MealType.LUNCH ? log.lunchStatus : log.dinnerStatus;
    if (mealStatus === MealStatus.COOKING) {
      throw new BadRequestException(
        `Cannot modify meal: ${dto.type.toLowerCase()} is already cooking!`,
      );
    }
    if (mealStatus === MealStatus.CANCELLED) {
      throw new BadRequestException(
        `Cannot modify meal: ${dto.type.toLowerCase()} has been cancelled for today.`,
      );
    }

    // 🔒 2. OFF Meal validation: নিজের মিল বন্ধ করার কাউন্ট ১ হতে হবে এবং ডুপ্লিকেট রিকোয়েস্ট ব্লক
    if (dto.category === RequestCategory.OFF) {
      if (dto.count !== 1) {
        throw new BadRequestException(
          'For turning meal OFF, count must be exactly 1.',
        );
      }
      const existingPendingOrApproved = await this.prisma.mealRequest.findFirst(
        {
          where: {
            logId: log.id,
            userId,
            type: dto.type,
            category: RequestCategory.OFF,
            status: { in: [RequestStatus.PENDING, RequestStatus.APPROVED] },
          },
        },
      );
      if (existingPendingOrApproved) {
        throw new BadRequestException(
          `You already have an active or approved OFF request for ${dto.type.toLowerCase()} today.`,
        );
      }
    }

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

        // 🔒 বাতিল মিলের জন্য কোনো রিকোয়েস্ট অনুমোদন করা যাবে না
        const mealStatus =
          request.type === 'LUNCH'
            ? request.log.lunchStatus
            : request.log.dinnerStatus;
        if (mealStatus === MealStatus.CANCELLED) {
          throw new BadRequestException(
            `Cannot approve request: ${request.type.toLowerCase()} has been cancelled for this day.`,
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

        // 🔒 Non-negative floor: মিল কাউন্ট কখনোই ঋণাত্মক হতে পারবে না
        const currentCount = (request.log as any)[countField] ?? 0;
        const newCount = Math.max(0, currentCount + incrementValue);

        await tx.dailyLog.update({
          where: { id: request.logId },
          data: {
            [countField]: newCount,
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
    const todayStr = this.getDhakaDate();
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

  async rejectRequest(requestId: string, managerId: string) {
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
          data: { status: RequestStatus.REJECTED },
        });

        return {
          result: { message: 'Request rejected successfully' },
          targetUserId: request.userId,
          mealType: request.type,
          mealCategory: request.category,
        };
      });

    // 🔴 Invalidation: আজকের লাইভ মিলের ক্যাশ মুছে দেওয়া
    const todayStr = this.getDhakaDate();
    this.eventEmitter.emit(CacheEvents.MEAL_UPDATED, {
      messId: manager.messId!,
      dateStr: todayStr,
    });

    // ⚡ BACKGROUND QUEUE: মেম্বারের ফোনে ব্যাকগ্রাউন্ড পুশ নোটিফিকেশন পাঠানো
    await this.notificationQueue.add('send-user-notification', {
      userId: targetUserId,
      title: '❌ Meal Request Rejected',
      body: `Manager rejected your ${mealCategory} request for ${mealType}.`,
    });

    return result;
  }

  // ম্যানেজারের জন্য বর্তমান সক্রিয় মাসের সব পেন্ডিং মিল রিকোয়েস্ট লোড করা
  async getPendingRequests(managerId: string) {
    const { mess } = await this.validator.validateManager(managerId);
    if (!mess.currentMonthId) return [];

    return this.prisma.mealRequest.findMany({
      where: {
        log: { monthId: mess.currentMonthId },
        status: RequestStatus.PENDING,
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
        log: { select: { id: true, lunchStatus: true, dinnerStatus: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateMealStatus(dto: UpdateMealStatusDto, managerId: string) {
    const { manager, mess } = await this.validator.validateManager(managerId);
    if (!mess.currentMonthId) {
      throw new BadRequestException('No active month session found.');
    }

    const todayStr = this.getDhakaDate();
    const log = await this.getOrCreateDailyLog(
      mess.currentMonthId,
      todayStr,
      mess.id,
    );

    const isLunch = dto.type === MealType.LUNCH;
    const updateData: Record<string, any> = isLunch
      ? { lunchStatus: dto.status }
      : { dinnerStatus: dto.status };

    if (dto.status === MealStatus.CANCELLED) {
      if (isLunch) {
        updateData.lunchCancelledBy = manager.name;
        updateData.lunchCount = 0;
      } else {
        updateData.dinnerCancelledBy = manager.name;
        updateData.dinnerCount = 0;
      }
    }

    const updatedLog = await this.prisma.dailyLog.update({
      where: { id: log.id },
      data: updateData,
    });

    // 🔴 Invalidation
    this.eventEmitter.emit(CacheEvents.MEAL_UPDATED, {
      messId: mess.id,
      dateStr: todayStr,
    });

    // ⚡ Notification to mess
    await this.notificationQueue.add('send-mess-notification', {
      messId: mess.id,
      title: `🍲 Meal Status Update: ${dto.type}`,
      body: `${dto.type} is now marked as ${dto.status} by Manager.`,
    });

    return {
      message: `${dto.type} status successfully updated to ${dto.status}`,
      log: updatedLog,
    };
  }

  async getDailyLiveCount(userId: string) {
    const { user, mess } = await this.validator.validateUserAndMess(userId);
    if (!mess.currentMonthId) return { message: 'No active month session' };

    const todayStr = this.getDhakaDate();
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

  // মেম্বার কর্তৃক ডেডলাইনের পূর্বে নিজের পেন্ডিং রিকোয়েস্ট বাতিল করা
  async cancelMealRequest(requestId: string, userId: string) {
    const { mess } = await this.validator.validateUserAndMess(userId);

    const request = await this.prisma.mealRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { log: true },
    });

    if (request.userId !== userId) {
      throw new BadRequestException(
        'You can only cancel your own meal requests.',
      );
    }

    if (request.status !== RequestStatus.PENDING) {
      throw new BadRequestException('Only pending requests can be cancelled.');
    }

    // 🔒 Cooking status barrier: রান্না শুরু হয়ে গেলে মেম্বার রিকোয়েস্ট বাতিল করতে পারবেন না
    const isLunch = request.type === 'LUNCH';
    const currentMealStatus = isLunch
      ? request.log?.lunchStatus
      : request.log?.dinnerStatus;
    if (currentMealStatus === MealStatus.COOKING) {
      throw new BadRequestException(
        `Cannot cancel request: ${request.type.toLowerCase()} is already cooking!`,
      );
    }
    if (currentMealStatus === MealStatus.CANCELLED) {
      throw new BadRequestException(
        `Cannot cancel request: ${request.type.toLowerCase()} has been cancelled for this day.`,
      );
    }

    this.checkDeadline(mess, request.type);

    await this.prisma.mealRequest.delete({
      where: { id: requestId },
    });

    const parts = (request.logId || '').split('_');
    const requestDateStr = parts[parts.length - 1] || this.getDhakaDate();
    this.eventEmitter.emit(CacheEvents.MEAL_UPDATED, {
      messId: mess.id,
      dateStr: requestDateStr,
    });

    return { message: 'Meal request cancelled successfully' };
  }

  // সুনির্দিষ্ট যেকোনো তারিখের মিল লগ ও রিকোয়েস্ট অডিট করা
  async getDailyLogByDate(dateStr: string, userId: string) {
    const { user, mess } = await this.validator.validateUserAndMess(userId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new BadRequestException('Invalid date format. Expected YYYY-MM-DD');
    }
    if (!mess.currentMonthId) return { message: 'No active month session' };

    const logId = `${mess.currentMonthId}_${dateStr}`;
    const cacheKey = CacheKeys.dailyMealLog(user.messId!, dateStr);

    return this.appCache.remember(cacheKey, 300, async () => {
      const log = await this.prisma.dailyLog.findUnique({
        where: { id: logId },
        include: {
          requests: {
            include: {
              user: { select: { id: true, name: true, role: true } },
            },
          },
        },
      });
      return log || { message: `No meal record found for date: ${dateStr}` };
    });
  }

  // 🇧🇩 সুনির্দিষ্ট বাংলাদেশ টাইমজোন (Asia/Dhaka) তারিখ (YYYY-MM-DD)
  private getDhakaDate(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Dhaka',
    }).format(new Date());
  }

  // 🇧🇩 সুনির্দিষ্ট বাংলাদেশ টাইমজোন (Asia/Dhaka) সময় (HH:MM)
  private getDhakaTime(): { hour: number; minute: number } {
    const timeStr = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dhaka',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date());
    const [hour, minute] = timeStr.split(':').map(Number);
    return { hour, minute };
  }

  private async getOrCreateDailyLog(
    monthId: string,
    dateStr: string,
    messId: string,
  ) {
    const logId = `${monthId}_${dateStr}`;
    const memberCount = await this.prisma.user.count({
      where: { messId, leftAt: null },
    });

    // ⚡ ATOMIC UPSERT: কনকারেন্ট রিকোয়েস্টে ডুপ্লিকেট কি (P2002) ক্র্যাশ প্রতিরোধ
    return this.prisma.dailyLog.upsert({
      where: { id: logId },
      create: {
        id: logId,
        monthId,
        lunchCount: memberCount,
        dinnerCount: memberCount,
      },
      update: {},
    });
  }

  private checkDeadline(
    mess: { lunchEndTime?: string | null; dinnerEndTime?: string | null },
    type: string,
  ) {
    const { hour: currentHour, minute: currentMinute } = this.getDhakaTime();

    const deadlineString =
      (type === 'LUNCH' ? mess.lunchEndTime : mess.dinnerEndTime) ||
      (type === 'LUNCH' ? '11:00' : '17:00');
    const [deadHour, deadMin] = deadlineString.split(':').map(Number);

    if (
      currentHour > deadHour ||
      (currentHour === deadHour && currentMinute >= deadMin)
    ) {
      throw new BadRequestException(
        `${type} deadline has passed (${deadlineString}). Modifications are locked.`,
      );
    }
  }
}
