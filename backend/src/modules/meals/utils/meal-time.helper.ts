import { BadRequestException } from '@nestjs/common';

export class MealTimeHelper {
  /**
   * 🇧🇩 সুনির্দিষ্ট বাংলাদেশ টাইমজোন (Asia/Dhaka) তারিখ (YYYY-MM-DD)
   */
  static getDhakaDate(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Dhaka',
    }).format(new Date());
  }

  /**
   * 🇧🇩 সুনির্দিষ্ট বাংলাদেশ টাইমজোন (Asia/Dhaka) সময় (HH:MM)
   */
  static getDhakaTime(): { hour: number; minute: number } {
    const timeStr = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dhaka',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date());
    const [hour, minute] = timeStr.split(':').map(Number);
    return { hour, minute };
  }

  /**
   * মিল রিকোয়েস্ট বা মডিফিকেশনের ডেডলাইন অতিক্রান্ত হয়েছে কিনা তা যাচাই
   */
  static checkDeadline(
    mess: { lunchEndTime?: string | null; dinnerEndTime?: string | null },
    type: string,
  ): void {
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
