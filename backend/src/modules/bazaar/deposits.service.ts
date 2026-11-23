import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ContextValidatorService } from '../../common/services/context-validator.service';
import { AppCacheService } from '../../common/cache/app-cache.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CacheKeys } from '../../common/cache/cache-keys';
import { CacheEvents } from '../../common/cache/cache-events.enum';
import { CreateDepositDto } from './dto/create-deposit.dto';
import { SubmitDepositRequestDto } from './dto/submit-deposit-request.dto';

@Injectable()
export class DepositsService {
  private readonly logger = new Logger(DepositsService.name);

  constructor(
    private prisma: PrismaService,
    private validator: ContextValidatorService,
    private appCache: AppCacheService,
    private eventEmitter: EventEmitter2,
    @InjectQueue('notification-queue') private notificationQueue: Queue,
  ) {}

  // ম্যানেজার কর্তৃক সরাসরি মেম্বারের ডিপোজিট লগ করা
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

  // মেম্বার সরাসরি বিকাশ/নগদ/ক্যাশ জমার রিকোয়েস্ট সাবমিট করা
  async submitDepositRequest(dto: SubmitDepositRequestDto, userId: string) {
    const { user, mess, activeMonthId } =
      await this.validator.validateUserMessAndActiveMonth(userId);

    const deposit = await this.prisma.deposit.create({
      data: {
        monthId: activeMonthId,
        userId,
        amount: dto.amount,
        status: 'PENDING_APPROVAL',
      },
    });

    const manager = await this.prisma.user.findUnique({
      where: { id: mess.managerId },
    });

    if (manager) {
      await this.notificationQueue.add('send-user-notification', {
        userId: manager.id,
        title: '💳 New Deposit Request',
        body: `${user.name} submitted a deposit of BDT ${dto.amount}${dto.note ? ` (${dto.note})` : ''} awaiting approval.`,
      });
    }

    return {
      message: 'Deposit request submitted and pending manager approval',
      deposit,
    };
  }

  // ম্যানেজার কর্তৃক সরাসরি মেম্বার ডিপোজিট অ্যাপ্রুভ করা
  async approveDeposit(depositId: string, managerId: string) {
    const { mess } = await this.validator.validateManager(managerId);

    const deposit = await this.prisma.deposit.findUniqueOrThrow({
      where: { id: depositId },
      include: { month: true },
    });

    if (deposit.month?.messId !== mess.id) {
      throw new ForbiddenException(
        'Access denied: Deposit belongs to another mess',
      );
    }

    if (deposit.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        `Deposit is not pending approval (Current status: ${deposit.status})`,
      );
    }

    const updated = await this.prisma.deposit.update({
      where: { id: depositId },
      data: { status: 'APPROVED' },
    });

    this.eventEmitter.emit(CacheEvents.BILLING_UPDATED, {
      messId: mess.id,
      monthId: deposit.monthId,
    });

    await this.notificationQueue.add('send-user-notification', {
      userId: deposit.userId,
      title: '✅ Deposit Approved!',
      body: `Manager approved your deposit of BDT ${deposit.amount}.`,
    });

    return updated;
  }

  // ম্যানেজার কর্তৃক সরাসরি মেম্বার ডিপোজিট রিজেক্ট করা
  async rejectDeposit(depositId: string, managerId: string) {
    const { mess } = await this.validator.validateManager(managerId);

    const deposit = await this.prisma.deposit.findUniqueOrThrow({
      where: { id: depositId },
      include: { month: true },
    });

    if (deposit.month?.messId !== mess.id) {
      throw new ForbiddenException(
        'Access denied: Deposit belongs to another mess',
      );
    }

    if (deposit.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        `Deposit is not pending approval (Current status: ${deposit.status})`,
      );
    }

    const updated = await this.prisma.deposit.update({
      where: { id: depositId },
      data: { status: 'REJECTED' },
    });

    this.eventEmitter.emit(CacheEvents.BILLING_UPDATED, {
      messId: mess.id,
      monthId: deposit.monthId,
    });

    await this.notificationQueue.add('send-user-notification', {
      userId: deposit.userId,
      title: '❌ Deposit Rejected',
      body: `Manager rejected your deposit of BDT ${deposit.amount}.`,
    });

    return updated;
  }

  // মেম্বারদের ডিপোজিট তালিকা লোড করা
  async getDeposits(userId: string) {
    const { mess } = await this.validator.validateUserAndMess(userId);
    if (!mess.currentMonthId) return [];

    const monthId = mess.currentMonthId;
    const cacheKey = CacheKeys.bazaarDeposits(mess.id, monthId);

    return this.appCache.remember(cacheKey, 60, () =>
      this.prisma.deposit.findMany({
        where: { monthId },
        include: {
          user: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }
}
