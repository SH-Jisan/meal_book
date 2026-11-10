import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Role } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ContextValidatorService } from '../../common/services/context-validator.service';
import { CompletePurchaseDto } from './dto/complete-purchase.dto';
import { CreateBazaarItemDto } from './dto/create-bazaar-item.dto';
import { CreateDepositDto } from './dto/create-deposit.dto';
import { SmartParseDto } from './dto/smart-parse.dto';
import { SmartSubmitDto } from './dto/smart-submit.dto';
import { RejectBazaarDto } from './dto/reject-bazaar.dto';
import { SmartBazaarParserService } from './parser/smart-bazaar-parser.service';
import { FuzzyNormalizer } from './parser/fuzzy-normalizer';
import { PatternMemoryService } from './parser/pattern-memory.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AppCacheService } from '../../common/cache/app-cache.service';
import { CacheKeys } from '../../common/cache/cache-keys';
import { CacheEvents } from '../../common/cache/cache-events.enum';

@Injectable()
export class BazaarService {
  private readonly logger = new Logger(BazaarService.name);

  constructor(
    private prisma: PrismaService,
    private validator: ContextValidatorService,
    private appCache: AppCacheService,
    private eventEmitter: EventEmitter2,
    @InjectQueue('notification-queue') private notificationQueue: Queue,
    private smartParser: SmartBazaarParserService,
    @Optional() private patternMemory?: PatternMemoryService,
  ) {}

  // -------------------------------------------------------------
  // ১. SMART NOTEPAD PARSE (PREVIEW ONLY)
  // -------------------------------------------------------------
  private resolveMember(
    name: string,
    members: { id: string; name: string }[],
  ): { id: string; name: string } | null {
    if (!name || members.length === 0) return null;
    const cleanName = name.toLowerCase().trim();

    // 1. Exact match
    const exact = members.find(
      (m) => m.name.toLowerCase().trim() === cleanName,
    );
    if (exact) return exact;

    // 2. Substring match
    const substringMatch = members.find(
      (m) =>
        m.name.toLowerCase().includes(cleanName) ||
        cleanName.includes(m.name.toLowerCase()),
    );
    if (substringMatch) return substringMatch;

    // 3. Fuzzy Levenshtein Distance (allowing up to 2 typos)
    let bestMatch: { id: string; name: string } | null = null;
    let minDistance = 3;

    for (const m of members) {
      const dist = FuzzyNormalizer.levenshteinDistance(
        cleanName,
        m.name.toLowerCase().trim(),
      );
      if (dist < minDistance) {
        minDistance = dist;
        bestMatch = m;
      }
    }

    return bestMatch;
  }

  async smartParse(dto: SmartParseDto, userId?: string) {
    let messId: string | undefined;
    let managerName: string | undefined;
    let messMembers: { id: string; name: string }[] = [];

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { messId: true },
      });
      messId = user?.messId || undefined;
      if (messId) {
        const mess = await this.prisma.mess.findUnique({
          where: { id: messId },
          select: { managerId: true },
        });
        if (mess?.managerId) {
          const manager = await this.prisma.user.findUnique({
            where: { id: mess.managerId },
            select: { name: true },
          });
          managerName = manager?.name;
        }
        messMembers = await this.prisma.user.findMany({
          where: { messId },
          select: { id: true, name: true },
        });
      }
    }

    const result = await this.smartParser.parse(
      dto.rawText,
      messId,
      managerName,
    );

    // If AI found memberDeposits, resolve userId (including shopper and mess members)
    if (result.memberDeposits && result.memberDeposits.length > 0) {
      result.memberDeposits = result.memberDeposits.map((md) => {
        const clean = md.memberName.toLowerCase().trim();
        const isShopper = [
          'ami',
          'shopper',
          'me',
          'nijer',
          'ami (shopper)',
        ].some((k) => clean.includes(k));
        if (isShopper && userId) {
          return {
            ...md,
            userId: userId,
          };
        }
        if (messMembers.length > 0) {
          const matched = this.resolveMember(md.memberName, messMembers);
          return {
            ...md,
            userId: matched?.id,
          };
        }
        return md;
      });
    }

    return result;
  }

  // -------------------------------------------------------------
  // ২. SMART NOTEPAD SUBMIT (ATOMIC TRANSACTION & APPROVAL WORKFLOW)
  // -------------------------------------------------------------
  async smartSubmit(dto: SmartSubmitDto, userId: string) {
    const { user, mess, activeMonthId } =
      await this.validator.validateUserMessAndActiveMonth(userId);

    const isManager = user.role === Role.MANAGER;
    const isAutoApproved = isManager;

    const hasMemberDeposits = !!(
      dto.memberDeposits && dto.memberDeposits.length > 0
    );
    const totalMemberDeposits = hasMemberDeposits
      ? dto.memberDeposits!.reduce(
          (sum: number, d: any) => sum + (d.amount || 0),
          0,
        )
      : 0;

    if (
      (!dto.items || dto.items.length === 0) &&
      (!dto.depositAmount || dto.depositAmount === 0) &&
      !hasMemberDeposits
    ) {
      throw new BadRequestException(
        'Please provide at least one bazaar item or deposit amount',
      );
    }
    const totalCost = (dto.items || []).reduce(
      (sum, item) => sum + item.cost,
      0,
    );
    const summaryString = dto.items
      .map((i) => `${i.name} (${i.quantity} ${i.unit}) - ${i.cost}tk`)
      .join(', ');

    // ⚛️ ATOMIC PRISMA TRANSACTION: বাজার ও ডিপোজিট একসাথে তৈরি করা
    const result = await this.prisma.$transaction(async (tx) => {
      // ১. BazaarItem তৈরি
      const item = await tx.bazaarItem.create({
        data: {
          monthId: activeMonthId,
          items: summaryString,
          cost: totalCost,
          status: isAutoApproved ? 'COMPLETED' : 'PENDING_APPROVAL',
          shopperId: userId,
          shopperName: user.name,
          rawText: dto.rawText,
          itemsDetail: dto.items as any,
          depositAmount: hasMemberDeposits
            ? totalMemberDeposits
            : dto.depositAmount || 0,
        },
      });

      // ২. মাল্টি-মেম্বার অথবা সিঙ্গেল ডিপোজিট তৈরি
      const createdDeposits: any[] = [];

      if (hasMemberDeposits) {
        const messMembers = await tx.user.findMany({
          where: { messId: mess.id },
          select: { id: true, name: true },
        });

        for (const md of dto.memberDeposits!) {
          if (!md.amount || md.amount === 0) continue;
          let targetUserId: string = md.userId || '';
          const clean = md.memberName.toLowerCase().trim();
          const isShopper = [
            'ami',
            'shopper',
            'me',
            'nijer',
            'ami (shopper)',
          ].some((k) => clean.includes(k));

          if (!targetUserId) {
            if (isShopper) {
              targetUserId = userId;
            } else {
              const matched = this.resolveMember(md.memberName, messMembers);
              targetUserId = matched ? matched.id : userId;
            }
          }

          const dep = await tx.deposit.create({
            data: {
              monthId: activeMonthId,
              userId: targetUserId,
              amount: md.amount,
              status: isAutoApproved ? 'APPROVED' : 'PENDING_APPROVAL',
              bazaarItemId: item.id,
            },
          });
          createdDeposits.push(dep);
        }

        if (createdDeposits.length > 0) {
          await tx.bazaarItem.update({
            where: { id: item.id },
            data: { depositId: createdDeposits[0].id },
          });
        }
      } else if (dto.depositAmount && dto.depositAmount > 0) {
        const singleDeposit = await tx.deposit.create({
          data: {
            monthId: activeMonthId,
            userId: userId,
            amount: dto.depositAmount,
            status: isAutoApproved ? 'APPROVED' : 'PENDING_APPROVAL',
            bazaarItemId: item.id,
          },
        });
        createdDeposits.push(singleDeposit);

        // BazaarItem এ ডিপোজিট রেফারেন্স লিংক করা
        await tx.bazaarItem.update({
          where: { id: item.id },
          data: { depositId: singleDeposit.id },
        });
      }

      // ৩. যদি ম্যানেজার নিজেই সাবমিট করে থাকেন তবে ইনস্ট্যান্ট মান্থলি কস্ট বৃদ্ধি
      if (isAutoApproved) {
        await tx.monthlyData.update({
          where: { id: activeMonthId },
          data: { totalBazaarCost: { increment: totalCost } },
        });
      }

      return { item, createdDeposits };
    });

    const depositDesc = hasMemberDeposits
      ? ` with ${result.createdDeposits.length} member deposits (BDT ${totalMemberDeposits})`
      : dto.depositAmount
        ? ` with BDT ${dto.depositAmount} deposit`
        : '';

    if (isAutoApproved) {
      // ম্যানেজার সাবমিট করায় সাথে সাথে ক্যাশ ইনভ্যালিডেট হবে
      this.eventEmitter.emit(CacheEvents.BAZAAR_UPDATED, {
        messId: mess.id,
        monthId: activeMonthId,
      });
      this.eventEmitter.emit(CacheEvents.BILLING_UPDATED, {
        messId: mess.id,
        monthId: activeMonthId,
      });

      await this.notificationQueue.add('send-mess-notification', {
        messId: mess.id,
        title: '🛒 Bazaar Added by Manager',
        body: `Manager logged bazaar of BDT ${totalCost}${depositDesc}.`,
      });
    } else {
      // মেম্বার সাবমিট করায় ম্যানেজারকে রিভিউ এর নোটিফিকেশন পাঠানো হবে
      const manager = await this.prisma.user.findUnique({
        where: { id: mess.managerId },
      });

      if (manager) {
        await this.notificationQueue.add('send-user-notification', {
          userId: manager.id,
          title: '🔔 Bazaar Approval Request',
          body: `${user.name} submitted a bazaar note (BDT ${totalCost})${depositDesc} awaiting your approval.`,
        });
      }
    }

    // 🧠 ৪. Supervised Human Feedback (ইউজার যদি কোনো আইটেমের নাম নিজে এডিট করে থাকে)
    if (this.patternMemory && dto.items && dto.items.length > 0) {
      for (const item of dto.items) {
        if (
          item.originalName &&
          item.name &&
          item.originalName.toLowerCase().trim() !==
            item.name.toLowerCase().trim()
        ) {
          // ইউজার নিজেই নাম সংশোধন করেছে, তাই কনফিডেন্স ১.০ দিয়ে মুখস্থ করবে
          await this.patternMemory.learnPattern(
            item.originalName,
            item.name,
            item.unit || 'kg',
            mess.id,
            'USER_MANUAL_CORRECTION',
          );
        }
      }
    }

    return {
      message: isAutoApproved
        ? 'Bazaar and deposit auto-approved successfully'
        : 'Bazaar submitted and pending manager approval',
      isAutoApproved,
      bazaarItem: result.item,
      deposit: result.createdDeposits[0] || null,
      deposits: result.createdDeposits,
    };
  }

  // -------------------------------------------------------------
  // ৩. APPROVE BAZAAR & DEPOSIT (MANAGER ONLY)
  // -------------------------------------------------------------
  async approveBazaar(itemId: string, managerId: string) {
    const { manager: _manager, mess } =
      await this.validator.validateManager(managerId);

    const item = await this.prisma.bazaarItem.findUnique({
      where: { id: itemId },
    });

    if (!item) throw new NotFoundException('Bazaar item not found');
    if (item.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        `Item is not pending approval (Current status: ${item.status})`,
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // ১. Bazaar Item status -> COMPLETED
      const approvedItem = await tx.bazaarItem.update({
        where: { id: itemId },
        data: { status: 'COMPLETED' },
      });

      // ২. সংশ্লিষ্ট ডিপোজিট থাকলে status -> APPROVED
      await tx.deposit.updateMany({
        where: {
          OR: [
            { bazaarItemId: itemId },
            ...(approvedItem.depositId ? [{ id: approvedItem.depositId }] : []),
          ],
        },
        data: { status: 'APPROVED' },
      });

      return approvedItem;
    });

    // ক্যাশ ইনভ্যালিডেশন
    if (mess.currentMonthId) {
      this.eventEmitter.emit(CacheEvents.BAZAAR_UPDATED, {
        messId: mess.id,
        monthId: mess.currentMonthId,
      });
      this.eventEmitter.emit(CacheEvents.BILLING_UPDATED, {
        messId: mess.id,
        monthId: mess.currentMonthId,
      });
    }

    // ক্রেতাকে কনফার্মেশন নোটিফিকেশন পাঠানো
    if (item.shopperId) {
      await this.notificationQueue.add('send-user-notification', {
        userId: item.shopperId,
        title: '✅ Bazaar Approved!',
        body: `Manager approved your bazaar purchase of BDT ${item.cost}.`,
      });
    }

    return updated;
  }

  // -------------------------------------------------------------
  // ৪. REJECT BAZAAR & DEPOSIT (MANAGER ONLY)
  // -------------------------------------------------------------
  async rejectBazaar(itemId: string, dto: RejectBazaarDto, managerId: string) {
    const { manager: _manager, mess: _mess } =
      await this.validator.validateManager(managerId);

    const item = await this.prisma.bazaarItem.findUnique({
      where: { id: itemId },
    });

    if (!item) throw new NotFoundException('Bazaar item not found');
    if (item.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        `Item is not pending approval (Current status: ${item.status})`,
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const rejectedItem = await tx.bazaarItem.update({
        where: { id: itemId },
        data: {
          status: 'REJECTED',
          rejectionReason: dto.reason,
        },
      });

      await tx.deposit.updateMany({
        where: {
          OR: [
            { bazaarItemId: itemId },
            ...(rejectedItem.depositId ? [{ id: rejectedItem.depositId }] : []),
          ],
        },
        data: { status: 'REJECTED' },
      });

      return rejectedItem;
    });

    // ক্রেতাকে নোটিফিকেশন দিয়ে কারণ জানানো
    if (item.shopperId) {
      await this.notificationQueue.add('send-user-notification', {
        userId: item.shopperId,
        title: '❌ Bazaar Request Rejected',
        body: `Manager rejected your bazaar submission. Reason: "${dto.reason}"`,
      });
    }

    return updated;
  }

  // -------------------------------------------------------------
  // ৫. লিগ্যাসি মেথডস (কমপ্যাটিবিলিটি অক্ষুণ্ণ রাখা)
  // -------------------------------------------------------------
  async createBazaarItem(dto: CreateBazaarItemDto, userId: string) {
    const { user, mess, activeMonthId } =
      await this.validator.validateUserMessAndActiveMonth(userId);

    const item = await this.prisma.bazaarItem.create({
      data: {
        monthId: activeMonthId,
        items: dto.items,
        status: 'PENDING',
      },
    });

    this.eventEmitter.emit(CacheEvents.BAZAAR_UPDATED, {
      messId: mess.id,
      monthId: activeMonthId,
    });

    await this.notificationQueue.add('send-mess-notification', {
      messId: mess.id,
      title: '🛒 New Bazaar Item Added!',
      body: `${user.name} added new items: "${dto.items}"`,
    });

    return item;
  }

  async completePurchase(
    itemId: string,
    dto: CompletePurchaseDto,
    userId: string,
  ) {
    const { user, mess } = await this.validator.validateUserAndMess(userId);
    const item = await this.prisma.bazaarItem.findUnique({
      where: { id: itemId },
    });

    if (!item) throw new NotFoundException('Bazaar item not found');
    if (item.status === 'COMPLETED')
      throw new BadRequestException('Purchase already completed');

    const updatedItem = await this.prisma.bazaarItem.update({
      where: { id: itemId },
      data: {
        cost: dto.cost,
        status: 'COMPLETED',
        shopperId: userId,
        shopperName: user.name,
      },
    });

    if (mess.currentMonthId) {
      this.eventEmitter.emit(CacheEvents.BAZAAR_UPDATED, {
        messId: mess.id,
        monthId: mess.currentMonthId,
      });
    }

    return updatedItem;
  }

  async getBazaarList(userId: string) {
    const { mess } = await this.validator.validateUserAndMess(userId);
    if (!mess.currentMonthId) return [];

    const monthId = mess.currentMonthId;
    const cacheKey = CacheKeys.bazaarList(mess.id, monthId);

    return this.appCache.remember(cacheKey, 300, () =>
      this.prisma.bazaarItem.findMany({
        where: { monthId },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  async addDeposit(dto: CreateDepositDto, managerId: string) {
    const { manager, mess } = await this.validator.validateManager(managerId);

    if (!mess.isMonthActive || !mess.currentMonthId) {
      throw new BadRequestException(
        'Active month summary session is not started',
      );
    }

    const targetUser = await this.prisma.user.findUnique({
      where: { id: dto.userId },
    });
    if (!targetUser || targetUser.messId !== manager.messId) {
      throw new BadRequestException('User not found in your mess');
    }

    const deposit = await this.prisma.deposit.create({
      data: {
        monthId: mess.currentMonthId,
        userId: dto.userId,
        amount: dto.amount,
        status: 'APPROVED',
      },
    });

    this.eventEmitter.emit(CacheEvents.BILLING_UPDATED, {
      messId: mess.id,
      monthId: mess.currentMonthId,
    });

    await this.notificationQueue.add('send-user-notification', {
      userId: dto.userId,
      title: '💳 Deposit Logged!',
      body: `Manager logged a deposit of BDT ${dto.amount} for you.`,
    });

    return deposit;
  }
}
