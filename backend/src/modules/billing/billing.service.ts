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

  // ২. রিয়েল-টাইম মিল রেট এবং ফাইনাল সামারি হিসাব করা (স্মার্ট ক্লোজড মাস সাপোর্ট ও মেম্বার লেজার সহ)
  async getMonthSummary(userId: string) {
    const { user, mess } = await this.validator.validateUserAndMess(userId);

    // ⚡ স্মার্ট ফলব্যাক: সক্রিয় মাস না থাকলে সর্বশেষ ক্লোজড মাসের হিস্ট্রি লোড করা
    let monthId = mess.currentMonthId;
    if (!monthId) {
      const latestMonth = await this.prisma.monthlyData.findFirst({
        where: { messId: mess.id },
        orderBy: { createdAt: 'desc' },
      });
      if (!latestMonth) {
        throw new NotFoundException('No active or previous month record found');
      }
      monthId = latestMonth.id;
    }

    const cacheKey = CacheKeys.billingSummary(mess.id, monthId);

    return this.appCache.remember(cacheKey, 300, async () => {
      // ১. মোট বাজার খরচ হিসাব
      const bazaarAggregate = await this.prisma.bazaarItem.aggregate({
        where: { monthId, status: 'COMPLETED' },
        _sum: { cost: true },
      });
      const totalBazaarCost = bazaarAggregate._sum.cost || 0;

      // ২. মেসের সর্বমোট মিল হিসাব
      const dailyLogs = await this.prisma.dailyLog.findMany({
        where: { monthId },
        select: {
          id: true,
          createdAt: true,
          lunchCount: true,
          dinnerCount: true,
          lunchStatus: true,
          dinnerStatus: true,
        },
      });

      const totalMeals = dailyLogs.reduce((sum, log) => {
        const lunch = log.lunchStatus === 'CANCELLED' ? 0 : log.lunchCount;
        const dinner = log.dinnerStatus === 'CANCELLED' ? 0 : log.dinnerCount;
        return sum + lunch + dinner;
      }, 0);
      const mealRate = totalMeals > 0 ? totalBazaarCost / totalMeals : 0;

      const formatDhakaDateStr = (
        date: Date | string | null | undefined,
      ): string | null => {
        if (!date) return null;
        try {
          return new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Dhaka',
          }).format(new Date(date));
        } catch {
          return null;
        }
      };

      const logDates = dailyLogs.map((log) => {
        const parts = (log.id || '').split('_');
        const dateCandidate = parts[parts.length - 1];
        let dateStr = dateCandidate;
        if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
          dateStr = formatDhakaDateStr(log.createdAt) || '2026-01-01';
        }
        return {
          dateStr,
          lunchStatus: log.lunchStatus,
          dinnerStatus: log.dinnerStatus,
        };
      });

      // ৩. মেম্বারদের মোট জমা টাকা গ্রুপিং
      const depositsGrouped = await this.prisma.deposit.groupBy({
        by: ['userId'],
        where: { monthId, status: 'APPROVED' },
        _sum: { amount: true },
      });

      const depositMap = new Map<string, number>();
      depositsGrouped.forEach((dep) =>
        depositMap.set(dep.userId, dep._sum.amount || 0),
      );

      // ৪. মেম্বারদের নির্দিষ্ট মিল রিকোয়েস্ট (OFF / GUEST) হিসাব
      const memberRequests = await this.prisma.mealRequest.findMany({
        where: {
          log: { monthId },
          status: 'APPROVED',
        },
        select: {
          userId: true,
          category: true,
          count: true,
        },
      });

      const memberMealAdjustments = new Map<string, number>();
      memberRequests.forEach((req) => {
        const current = memberMealAdjustments.get(req.userId) || 0;
        const change = req.category === 'OFF' ? -req.count : req.count;
        memberMealAdjustments.set(req.userId, current + change);
      });

      // ৫. মেসের সকল মেম্বার ফেচ করা
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
          joinedAt: true,
          leftAt: true,
        },
      });

      // ৬. প্রতি মেম্বারের পূর্ণাঙ্গ লেজার (জমা, মিল সংখ্যা, মিল খরচ, নেট ব্যালেন্স)
      const memberSummaries = members.map((member) => {
        const totalDeposit = depositMap.get(member.id) || 0;
        const hasLeft = member.messId !== user.messId! || !!member.leftAt;
        const adjustment = memberMealAdjustments.get(member.id) || 0;

        const memberJoinedStr = formatDhakaDateStr(member.joinedAt);
        const memberLeftStr = formatDhakaDateStr(member.leftAt);

        // ⚡ FAIR RESIDENCY PRORATION: মেম্বার যে দিনগুলোতে মেসে অবস্থান করেছেন শুধুমাত্র সেই দিনগুলোর কার্যকর মিল হিসাব করা (বাতিল মিল বাদ দিয়ে)
        let memberDefaultMeals = 0;
        if (logDates.length > 0) {
          for (const item of logDates) {
            const joinedOk =
              !memberJoinedStr || item.dateStr >= memberJoinedStr;
            const leftOk = !memberLeftStr || item.dateStr <= memberLeftStr;

            if (joinedOk && leftOk) {
              let activeDayMeals = 0;
              if (item.lunchStatus !== 'CANCELLED') activeDayMeals += 1;
              if (item.dinnerStatus !== 'CANCELLED') activeDayMeals += 1;
              memberDefaultMeals += activeDayMeals;
            }
          }
        }

        const individualMeals = Math.max(0, memberDefaultMeals + adjustment);
        const mealCost = Number((individualMeals * mealRate).toFixed(2));
        const balance = Number((totalDeposit - mealCost).toFixed(2));

        return {
          memberId: member.id,
          name: member.name,
          email: member.email,
          totalDeposit,
          totalMeals: individualMeals,
          mealCost,
          balance,
          hasLeft,
          joinedAt: member.joinedAt,
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

    // 🔒 ফিন্যান্সিয়াল ইন্টিগ্রিটি গার্ড: পেন্ডিং বাজার বা ডিপোজিট থাকলে মাস বন্ধ করা যাবে না
    const [pendingBazaarCount, pendingDepositCount] = await Promise.all([
      this.prisma.bazaarItem.count({
        where: { monthId, status: 'PENDING_APPROVAL' },
      }),
      this.prisma.deposit.count({
        where: { monthId, status: 'PENDING_APPROVAL' },
      }),
    ]);

    if (pendingBazaarCount > 0 || pendingDepositCount > 0) {
      throw new BadRequestException(
        `Cannot close month: There are ${pendingBazaarCount} pending bazaar items and ${pendingDepositCount} pending deposits awaiting approval. Please approve or reject them before closing the month.`,
      );
    }

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
