import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { MealStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ContextValidatorService } from '../../common/services/context-validator.service';
import { MealType, UpdateMealDto } from './dto/update-meal.dto';
import { UpdateMealStatusDto } from './dto/update-meal-status.dto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AppCacheService } from '../../common/cache/app-cache.service';
import { CacheKeys } from '../../common/cache/cache-keys';
import { CacheEvents } from '../../common/cache/cache-events.enum';
import { MealTimeHelper } from './utils/meal-time.helper';
import { MealRequestsService } from './meal-requests.service';

@Injectable()
export class MealsService {
  constructor(
    private prisma: PrismaService,
    private validator: ContextValidatorService,
    private appCache: AppCacheService,
    private eventEmitter: EventEmitter2,
    @InjectQueue('notification-queue') private notificationQueue: Queue,
    @Optional() private mealRequestsService?: MealRequestsService,
  ) {}

  // -------------------------------------------------------------
  // ১. MEAL REQUESTS DELEGATION (BACKWARD COMPATIBILITY FACADE)
  // -------------------------------------------------------------
  async requestMealUpdate(dto: UpdateMealDto, userId: string) {
    if (this.mealRequestsService) {
      return this.mealRequestsService.requestMealUpdate(dto, userId);
    }
    throw new BadRequestException('MealRequestsService is not available');
  }

  async approveRequest(requestId: string, managerId: string) {
    if (this.mealRequestsService) {
      return this.mealRequestsService.approveRequest(requestId, managerId);
    }
    throw new BadRequestException('MealRequestsService is not available');
  }

  async rejectRequest(requestId: string, managerId: string) {
    if (this.mealRequestsService) {
      return this.mealRequestsService.rejectRequest(requestId, managerId);
    }
    throw new BadRequestException('MealRequestsService is not available');
  }

  async getPendingRequests(managerId: string) {
    if (this.mealRequestsService) {
      return this.mealRequestsService.getPendingRequests(managerId);
    }
    return [];
  }

  async cancelMealRequest(requestId: string, userId: string) {
    if (this.mealRequestsService) {
      return this.mealRequestsService.cancelMealRequest(requestId, userId);
    }
    throw new BadRequestException('MealRequestsService is not available');
  }

  // -------------------------------------------------------------
  // ২. DAILY MEAL LOG & STATUS WORKFLOWS
  // -------------------------------------------------------------
  async updateMealStatus(dto: UpdateMealStatusDto, managerId: string) {
    const { manager, mess } = await this.validator.validateManager(managerId);
    if (!mess.currentMonthId) {
      throw new BadRequestException('No active month session found.');
    }

    const todayStr = MealTimeHelper.getDhakaDate();
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

    const todayStr = MealTimeHelper.getDhakaDate();
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

  async getOrCreateDailyLog(monthId: string, dateStr: string, messId: string) {
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
}
