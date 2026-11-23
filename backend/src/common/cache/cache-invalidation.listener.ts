import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AppCacheService } from './app-cache.service';
import { CacheEvents } from './cache-events.enum';
import { CacheKeys } from './cache-keys';
import {
  BazaarUpdatedEvent,
  BillingUpdatedEvent,
  ManagerTransferredEvent,
  MealUpdatedEvent,
  MemberJoinedEvent,
  MemberLeftEvent,
  MessUpdatedEvent,
  UserProfileUpdatedEvent,
} from './events/cache-events.payload';

@Injectable()
export class CacheInvalidationListener {
  private readonly logger = new Logger(CacheInvalidationListener.name);

  constructor(private readonly appCache: AppCacheService) {}

  // 🧹 উক্ত মেসের সকল প্রকার ক্যাশ (Members, Bazaar, Billing, Meals) এক ক্লিকে রিসেট করা
  @OnEvent(CacheEvents.MESS_UPDATED)
  async handleFullMessReset(event: MessUpdatedEvent) {
    this.logger.log(`🧹 Wiping ALL Cache Keys for Mess [${event.messId}]`);

    const todayStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Dhaka',
    }).format(new Date());
    const keys = [
      CacheKeys.messMembers(event.messId),
      CacheKeys.messDetails(event.messId),
      CacheKeys.dailyMealLog(event.messId, todayStr),
    ];

    if (event.monthId) {
      keys.push(
        CacheKeys.bazaarList(event.messId, event.monthId),
        CacheKeys.bazaarDeposits(event.messId, event.monthId),
        CacheKeys.billingSummary(event.messId, event.monthId),
      );
    }

    await this.appCache.delMany(keys);
  }

  @OnEvent(CacheEvents.MEMBER_JOINED)
  async handleMemberJoined(event: MemberJoinedEvent) {
    this.logger.log(
      `🧹 Invalidating cache for Member Joined in Mess [${event.messId}]`,
    );
    const keys = [
      CacheKeys.messMembers(event.messId),
      CacheKeys.messDetails(event.messId),
      CacheKeys.userProfile(event.memberEmail),
    ];
    if (event.managerEmail) {
      keys.push(CacheKeys.userProfile(event.managerEmail));
    }
    await this.appCache.delMany(keys);
  }

  @OnEvent(CacheEvents.MEMBER_LEFT)
  async handleMemberLeft(event: MemberLeftEvent) {
    this.logger.log(
      `🧹 Invalidating cache for Member Left in Mess [${event.messId}]`,
    );
    const keys = [
      CacheKeys.messMembers(event.messId),
      CacheKeys.messDetails(event.messId),
      CacheKeys.userProfile(event.memberEmail),
    ];
    if (event.monthId) {
      keys.push(CacheKeys.billingSummary(event.messId, event.monthId));
    }
    await this.appCache.delMany(keys);
  }

  @OnEvent(CacheEvents.MANAGER_TRANSFERRED)
  async handleManagerTransferred(event: ManagerTransferredEvent) {
    this.logger.log(
      `🧹 Invalidating cache for Manager Transferred in Mess [${event.messId}]`,
    );
    const keys = [
      CacheKeys.messMembers(event.messId),
      CacheKeys.messDetails(event.messId),
      CacheKeys.userProfile(event.oldManagerEmail),
      CacheKeys.userProfile(event.newManagerEmail),
    ];
    await this.appCache.delMany(keys);
  }

  @OnEvent(CacheEvents.BAZAAR_UPDATED)
  async handleBazaarUpdated(event: BazaarUpdatedEvent) {
    this.logger.log(
      `🧹 Invalidating Bazaar & Billing cache for Mess [${event.messId}]`,
    );
    const keys = [
      CacheKeys.bazaarList(event.messId, event.monthId),
      CacheKeys.bazaarDeposits(event.messId, event.monthId),
      CacheKeys.billingSummary(event.messId, event.monthId),
    ];
    await this.appCache.delMany(keys);
  }

  @OnEvent(CacheEvents.BILLING_UPDATED)
  async handleBillingUpdated(event: BillingUpdatedEvent) {
    this.logger.log(
      `🧹 Invalidating Billing Summary cache for Mess [${event.messId}]`,
    );
    await this.appCache.delMany([
      CacheKeys.billingSummary(event.messId, event.monthId),
      CacheKeys.bazaarDeposits(event.messId, event.monthId),
    ]);
  }

  @OnEvent(CacheEvents.MEAL_UPDATED)
  async handleMealUpdated(event: MealUpdatedEvent) {
    this.logger.log(
      `🧹 Invalidating Daily Meal Log cache for Mess [${event.messId}] Date [${event.dateStr}]`,
    );
    await this.appCache.del(
      CacheKeys.dailyMealLog(event.messId, event.dateStr),
    );
  }

  @OnEvent(CacheEvents.USER_PROFILE_UPDATED)
  async handleUserProfileUpdated(event: UserProfileUpdatedEvent) {
    this.logger.log(`🧹 Invalidating User Profile cache for [${event.email}]`);
    await this.appCache.del(CacheKeys.userProfile(event.email));
  }
}
