import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Role } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ContextValidatorService } from '../../common/services/context-validator.service';
import { MessCodeNotFoundException } from '../../common/exceptions/domain.exception';
import { CreateMessDto } from './dto/create-mess.dto';
import { JoinMessDto } from './dto/join-mess.dto';
import { TransferManagerDto } from './dto/transfer-manager.dto';
import { UpdateMessSettingsDto } from './dto/update-mess-settings.dto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AppCacheService } from '../../common/cache/app-cache.service';
import { CacheKeys } from '../../common/cache/cache-keys';
import { CacheEvents } from '../../common/cache/cache-events.enum';

@Injectable()
export class MessService {
  constructor(
    private prisma: PrismaService,
    private validator: ContextValidatorService,
    private appCache: AppCacheService,
    private eventEmitter: EventEmitter2,
    @InjectQueue('notification-queue') private notificationQueue: Queue,
  ) {}

  // ১. নতুন মেস তৈরি করা
  async createMess(dto: CreateMessDto, userId: string) {
    await this.validator.validateUserHasNoMess(userId);

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const emailPart = user.email
      .split('@')[0]
      .substring(0, 2)
      .toUpperCase()
      .padEnd(2, 'X');
    const timePart = Date.now().toString(36).toUpperCase().slice(-4);
    const code = `MESS-${emailPart}${timePart}`;

    const mess = await this.prisma.$transaction(async (tx) => {
      const mess = await tx.mess.create({
        data: {
          name: dto.name,
          code,
          managerId: userId,
        },
      });

      await tx.user.update({
        where: { id: userId },
        data: {
          messId: mess.id,
          role: Role.MANAGER,
          joinedAt: new Date(),
          leftAt: null,
        },
      });
      return mess;
    });

    // 📡 Event-Driven Cache Invalidation
    this.eventEmitter.emit(CacheEvents.USER_PROFILE_UPDATED, {
      email: user.email,
    });

    return { message: 'Mess created successfully', mess };
  }

  // ২. ইনভাইট কোড দিয়ে মেসে জয়েন করা
  async joinMess(dto: JoinMessDto, userId: string) {
    await this.validator.validateUserHasNoMess(userId);

    const mess = await this.prisma.mess.findUnique({
      where: { code: dto.code.toUpperCase() },
    });

    if (!mess) {
      throw new MessCodeNotFoundException();
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        messId: mess.id,
        role: Role.MEMBER,
        joinedAt: new Date(),
        leftAt: null,
      },
    });

    // 📡 Event-Driven Cache Invalidation
    const manager = await this.prisma.user.findUnique({
      where: { id: mess.managerId },
    });
    this.eventEmitter.emit(CacheEvents.MEMBER_JOINED, {
      messId: mess.id,
      memberEmail: updatedUser.email,
      managerEmail: manager?.email,
    });

    return { message: 'Successfully joined the mess', messName: mess.name };
  }

  // ৩. মেসের সব মেম্বারদের তালিকা দেখা (Cache-Aside Pattern)
  async getMembers(userId: string) {
    const { user } = await this.validator.validateUserAndMess(userId);
    const cacheKey = CacheKeys.messMembers(user.messId!);

    return this.appCache.remember(cacheKey, 60, () =>
      this.prisma.user.findMany({
        where: {
          messId: user.messId!,
        },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          joinedAt: true,
        },
        orderBy: {
          joinedAt: 'asc',
        },
      }),
    );
  }

  // ৪. মেস থেকে লিভ নেওয়া (Leave Mess)
  async leaveMess(userId: string) {
    const { user, mess } = await this.validator.validateUserAndMess(userId);

    if (user.role === Role.MANAGER) {
      const otherMemberCount = await this.prisma.user.count({
        where: { messId: mess.id, id: { not: userId } },
      });

      if (otherMemberCount > 0) {
        throw new BadRequestException(
          'Managers cannot leave the mess while other members are still in the mess. Please transfer manager ownership first.',
        );
      }
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        messId: null,
        role: Role.MEMBER,
        joinedAt: null,
        leftAt: new Date(),
      },
    });

    // 📡 Event-Driven Cache Invalidation
    this.eventEmitter.emit(CacheEvents.MEMBER_LEFT, {
      messId: mess.id,
      memberEmail: user.email,
      monthId: mess.currentMonthId,
    });

    return { message: 'Successfully left the mess' };
  }

  // ৫. মেস ম্যানেজার পরিবর্তন ও প্রমোট করা (Transfer Manager Ownership)
  async transferManager(dto: TransferManagerDto, currentManagerId: string) {
    const { manager, mess } =
      await this.validator.validateManager(currentManagerId);
    if (dto.newManagerId === currentManagerId) {
      throw new BadRequestException(
        'You are already the manager of this mess.',
      );
    }
    const newManager = await this.prisma.user.findUnique({
      where: { id: dto.newManagerId },
    });
    if (!newManager || newManager.messId !== mess.id) {
      throw new BadRequestException(
        'The selected member does not belong to this mess.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: currentManagerId },
        data: { role: Role.MEMBER },
      });
      await tx.user.update({
        where: { id: dto.newManagerId },
        data: { role: Role.MANAGER },
      });
      await tx.mess.update({
        where: { id: mess.id },
        data: { managerId: dto.newManagerId },
      });
    });

    // 📡 Event-Driven Cache Invalidation
    this.eventEmitter.emit(CacheEvents.MANAGER_TRANSFERRED, {
      messId: mess.id,
      oldManagerEmail: manager.email,
      newManagerEmail: newManager.email,
    });

    // ⚡ BATCHED MULTICAST: একটি সিঙ্গেল ব্যাকগ্রাউন্ড জবে মেসের সব মেম্বারকে পুশ পাঠানো
    await this.notificationQueue.add('send-mess-notification', {
      messId: mess.id,
      title: '👑 Manager Updated!',
      body: `${newManager.name} is now the manager of ${mess.name}.`,
    });
    return {
      message: `Manager ownership successfully transferred to ${newManager.name}`,
    };
  }

  // ৬. বর্তমান মেসের সম্পূর্ণ বিবরণ ও ডেডলাইন কনফিগারেশন লোড করা
  async getMessDetails(userId: string) {
    const { mess } = await this.validator.validateUserAndMess(userId);
    const cacheKey = CacheKeys.messDetails(mess.id);

    return this.appCache.remember(cacheKey, 60, async () => {
      const [manager, memberCount, activeMonth] = await Promise.all([
        this.prisma.user.findUnique({
          where: { id: mess.managerId },
          select: { id: true, name: true, email: true, phone: true },
        }),
        this.prisma.user.count({
          where: { messId: mess.id, leftAt: null },
        }),
        mess.currentMonthId
          ? this.prisma.monthlyData.findUnique({
              where: { id: mess.currentMonthId },
              select: { id: true, monthName: true, totalBazaarCost: true },
            })
          : null,
      ]);

      return {
        id: mess.id,
        name: mess.name,
        code: mess.code,
        managerId: mess.managerId,
        manager,
        memberCount,
        isMonthActive: mess.isMonthActive,
        currentMonthId: mess.currentMonthId,
        activeMonth,
        requestStartTime: mess.requestStartTime,
        lunchEndTime: mess.lunchEndTime,
        dinnerEndTime: mess.dinnerEndTime,
        createdAt: mess.createdAt,
      };
    });
  }

  // ৭. মেসের নাম ও মিল ডেডলাইন সেটিংস আপডেট করা (ম্যানেজার অনলি)
  async updateMessSettings(dto: UpdateMessSettingsDto, managerId: string) {
    const { mess } = await this.validator.validateManager(managerId);

    const updatedMess = await this.prisma.mess.update({
      where: { id: mess.id },
      data: {
        ...(dto.name ? { name: dto.name.trim() } : {}),
        ...(dto.requestStartTime
          ? { requestStartTime: dto.requestStartTime }
          : {}),
        ...(dto.lunchEndTime ? { lunchEndTime: dto.lunchEndTime } : {}),
        ...(dto.dinnerEndTime ? { dinnerEndTime: dto.dinnerEndTime } : {}),
      },
    });

    this.eventEmitter.emit(CacheEvents.MESS_UPDATED, {
      messId: mess.id,
      monthId: mess.currentMonthId,
    });

    return {
      message: 'Mess settings updated successfully',
      mess: updatedMess,
    };
  }

  // ৮. মেস থেকে অবাঞ্ছিত মেম্বার রিমুভ/কিক করা (ম্যানেজার অনলি)
  async removeMember(targetMemberId: string, managerId: string) {
    const { manager, mess } = await this.validator.validateManager(managerId);

    if (targetMemberId === managerId) {
      throw new BadRequestException(
        'Managers cannot remove themselves. Transfer manager ownership first or leave mess if alone.',
      );
    }

    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetMemberId },
    });

    if (!targetUser || targetUser.messId !== mess.id) {
      throw new BadRequestException(
        'Target user is not an active member of your mess.',
      );
    }

    await this.prisma.user.update({
      where: { id: targetMemberId },
      data: {
        messId: null,
        role: Role.MEMBER,
        joinedAt: null,
        leftAt: new Date(),
      },
    });

    this.eventEmitter.emit(CacheEvents.MEMBER_LEFT, {
      messId: mess.id,
      memberEmail: targetUser.email,
      monthId: mess.currentMonthId,
    });

    await this.notificationQueue.add('send-user-notification', {
      userId: targetMemberId,
      title: '🚪 Removed from Mess',
      body: `You have been removed from ${mess.name} by Manager ${manager.name}.`,
    });

    return {
      message: `Member ${targetUser.name} successfully removed from the mess.`,
    };
  }
}
