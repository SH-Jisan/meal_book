// =========================================================================
// 🔑 Centralized Strict Namespace Cache Key Factory
// Enforces standard format: <module>:<entity>:<id/key>:<attribute>
// =========================================================================

export class CacheKeys {
  // ১. Auth মডিউলের জন্য ক্যাশ কি জেনারেটর
  static tokenBlacklist(token: string): string {
    return `auth:blacklist:${token}`;
  }

  static userProfile(email: string): string {
    return `auth:user:${email.toLowerCase()}`;
  }

  static logoutAll(userId: string): string {
    return `auth:logout_all:${userId}`;
  }

  // ২. Mess মডিউলের জন্য ক্যাশ কি জেনারেটর
  static messMembers(messId: string): string {
    return `mess:${messId}:members`;
  }

  static messDetails(messId: string): string {
    return `mess:${messId}:details`;
  }

  // ৩. Meals মডিউলের জন্য ক্যাশ কি জেনারেটর
  static dailyMealLog(messId: string, dateStr: string): string {
    return `meals:${messId}:${dateStr}:daily`;
  }

  // ৪. Bazaar মডিউলের জন্য ক্যাশ কি জেনারেটর
  static bazaarList(messId: string, monthId: string): string {
    return `bazaar:${messId}:${monthId}:list`;
  }

  static bazaarDeposits(messId: string, monthId: string): string {
    return `bazaar:${messId}:${monthId}:deposits`;
  }

  // ৫. Billing মডিউলের জন্য ক্যাশ কি জেনারেটর
  static billingSummary(messId: string, monthId: string): string {
    return `billing:${messId}:${monthId}:summary`;
  }

  // ৬. System মডিউলের টেলিমেট্রি ক্যাশ কি জেনারেটর
  static monthlyMetrics(monthStr: string, metricKey: string): string {
    return `metrics:monthly:${monthStr}:${metricKey}`;
  }
}
