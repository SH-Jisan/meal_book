import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { NotificationService } from './notification.service';

interface NotificationJobData {
  userId?: string;
  messId?: string;
  title: string;
  body: string;
}

@Processor('notification-queue', {
  drainDelay: 120,
  stalledInterval: 60000,
})
export class NotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(private notificationService: NotificationService) {
    super();
  }

  // ব্যাকগ্রাউন্ডে যে জবগুলো প্রসেস হবে
  async process(
    job: Job<NotificationJobData, unknown, string>,
  ): Promise<unknown> {
    this.logger.log(
      `Processing background job '${job.name}' (Job ID: ${job.id})`,
    );

    switch (job.name) {
      case 'send-user-notification': {
        const { userId, title, body } = job.data;
        if (userId) {
          return await this.notificationService.sendNotificationToUser(
            userId,
            title,
            body,
          );
        }
        return null;
      }

      case 'send-mess-notification': {
        const { messId, title, body } = job.data;
        if (messId) {
          return await this.notificationService.sendNotificationToMess(
            messId,
            title,
            body,
          );
        }
        return null;
      }

      default:
        this.logger.warn(`Unknown job name: ${job.name}`);
        return null;
    }
  }
}
