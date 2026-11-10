import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ContextValidatorService } from '../../common/services/context-validator.service';
import { MonthAlreadyActiveException } from '../../common/exceptions/domain.exception';
import { StartMonthDto } from './dto/start-month.dto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AppCacheService } from '../../common/cache/app-cache.service';
import { CacheKeys } from '../../common/cache/cache-keys';
import { CacheEvents } from '../../common/cache/cache-events.enum';

@Injectable()
export class BillingService {
  constructor(
    private prisma: PrismaService,
    private validator: ContextValidatorService,
    private appCache: AppCacheService,
    private eventEmitter: EventEmitter2,
  ) {}

  // ১. নতুন মাসের সেশন শুরু করা (Only Manager)
  async startNewMonth(dto: StartMonthDto, managerId: string) {
    const { manager, mess } = await this.validator.validateManager(managerId);

    if (mess.isMonthActive) {
      throw new MonthAlreadyActiveException();
    }

    const month = await this.prisma.$transaction(async (tx) => {
      const createdMonth = await tx.monthlyData.create({
        data: {
          monthName: dto.monthName,
          messId: manager.messId!,
        },
      });

      await tx.mess.update({
        where: { id: manager.messId! },
        data: {
          isMonthActive: true,
          currentMonthId: createdMonth.id,
        },
      });

      return createdMonth;
    });

    // 🔴 Invalidation: নতুন মাস শুরু হওয়ায় সামারির ক্যাশ ক্লিয়ার করা
    // 📡 Event-Driven Cache Invalidation
    this.eventEmitter.emit(CacheEvents.BILLING_UPDATED, {
      messId: mess.id,
      monthId: month.id,
    });

    return month;
  }

  // ২. রিয়েল-টাইম মিল রেট এবং ফাইনাল সামারি হিসাব করা (Cache-Aside Pattern)
  async getMonthSummary(userId: string) {
    const { user, mess } = await this.validator.validateUserAndMess(userId);
    if (!mess.currentMonthId)
      throw new NotFoundException('No active or previous month record found');

    const monthId = mess.currentMonthId;
    const cacheKey = CacheKeys.billingSummary(mess.id, monthId);

    return this.appCache.remember(cacheKey, 300, async () => {
      // 🗄️ ক্যাশে না থাকলে ডাটাবেজে ভারী Aggregation কুয়েরি চালানো
      const bazaarAggregate = await this.prisma.bazaarItem.aggregate({
        where: { monthId, status: 'COMPLETED' },
        _sum: { cost: true },
      });
      const totalBazaarCost = bazaarAggregate._sum.cost || 0;

      const dailyLogs = await this.prisma.dailyLog.findMany({
        where: { monthId },
        select: { lunchCount: true, dinnerCount: true },
      });

      const totalMeals = dailyLogs.reduce(
        (sum, log) => sum + log.lunchCount + log.dinnerCount,
        0,
      );
      const mealRate = totalMeals > 0 ? totalBazaarCost / totalMeals : 0;

      const depositsGrouped = await this.prisma.deposit.groupBy({
        by: ['userId'],
        where: { monthId, status: 'APPROVED' },
        _sum: { amount: true },
      });

      const depositMap = new Map<string, number>();
      depositsGrouped.forEach((dep) =>
        depositMap.set(dep.userId, dep._sum.amount || 0),
      );

      const members = await this.prisma.user.findMany({
        where: {
          OR: [
            { messId: user.messId! },
            { deposits: { some: { monthId } } },
            { requests: { some: { log: { monthId } } } },
          ],
        },
        select: {
          id: true,
          name: true,
          email: true,
          messId: true,
          leftAt: true,
        },
      });

      const memberSummaries = members.map((member) => {
        const totalDeposit = depositMap.get(member.id) || 0;
        const hasLeft = member.messId !== user.messId! || !!member.leftAt;
        return {
          memberId: member.id,
          name: member.name,
          email: member.email,
          totalDeposit,
          hasLeft,
          leftAt: member.leftAt,
        };
      });

      return {
        monthId,
        totalBazaarCost,
        totalMeals,
        mealRate: Number(mealRate.toFixed(2)),
        members: memberSummaries,
      };
    });
  }

  // ৩. মাসের সেশন বন্ধ/ক্লোজ করা (Only Manager)
  async closeMonthSession(managerId: string) {
    const { mess } = await this.validator.validateManager(managerId);

    if (!mess.isMonthActive || !mess.currentMonthId) {
      throw new BadRequestException('No active month session to close');
    }

    const monthId = mess.currentMonthId;

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.monthlyData.update({
        where: { id: monthId },
        data: { isClosed: true },
      });

      await tx.mess.update({
        where: { id: mess.id },
        data: {
          isMonthActive: false,
          currentMonthId: null,
        },
      });

      return { message: 'Month session closed and archived successfully' };
    });

    // 🔴 Invalidation: মাস বন্ধ হয়ে যাওয়ায় সামারির ক্যাশ ক্লিয়ার করা
    // 📡 Event-Driven Cache Invalidation
    this.eventEmitter.emit(CacheEvents.BILLING_UPDATED, {
      messId: mess.id,
      monthId,
    });

    return result;
  }
}
