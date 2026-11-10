import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CacheModule } from '@nestjs/cache-manager';
import { BullModule } from '@nestjs/bullmq';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './common/prisma/prisma.module';
import { validate } from './config/env.validation';
import { AuthModule } from './modules/auth/auth.module';
import { MessModule } from './modules/mess/mess.module';
import { MealsModule } from './modules/meals/meals.module';
import { BazaarModule } from './modules/bazaar/bazaar.module';
import { BillingModule } from './modules/billing/billing.module';
import { NotificationModule } from './modules/notification/notification.module';
import { SystemModule } from './modules/system/system.module';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { MetricsInterceptor } from './common/interceptors/metrics.interceptors';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppCacheModule } from './common/cache/cache.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate,
    }),
    AppCacheModule,
    CacheModule.register({
      isGlobal: true,
      ttl: 300000,
      max: 500,
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 100,
      },
    ]),
    PrometheusModule.register({
      defaultMetrics: {
        enabled: true,
      },
      path: '/metrics',
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => {
        let host =
          configService.get<string>('REDIS_HOST_1') ||
          configService.get<string>('REDIS_HOST');
        let password =
          configService.get<string>('REDIS_PASSWORD_1') ||
          configService.get<string>('REDIS_PASSWORD');
        const secondaryHost = configService.get<string>('REDIS_HOST_2');
        const secondaryPassword = configService.get<string>('REDIS_PASSWORD_2');

        // ⚡ Startup Auto-Check: ১ মিলিসেকেন্ডে ১ম Redis সচল আছে কিনা চেক করা
        if (host && secondaryHost) {
          try {
            const Redis = (await import('ioredis')).default;
            const pingClient = new Redis({
              host,
              port: configService.get<number>('REDIS_PORT_1', 6379),
              password,
              tls:
                (configService.get<string>('REDIS_TLS_1') ||
                  configService.get<string>('REDIS_TLS')) === 'true'
                  ? {}
                  : undefined,
              connectTimeout: 2000,
              maxRetriesPerRequest: 1,
            });
            // ⚡ PING এবং SET টেস্ট (যাতে Limit Exceeded হলে সঙ্গে সঙ্গে ২য় রডিসে সুইচ করে)
            await pingClient.set('health_check', '1', 'EX', 10);
            await pingClient.quit();
          } catch {
            console.warn(
              `⚠️ Primary Redis (${host}) limit reached or offline! Switched to Secondary Backup Redis (${secondaryHost}).`,
            );
            host = secondaryHost;
            password = secondaryPassword;
          }
        }

        return {
          connection: {
            host,
            port: 6379,
            password,
            tls: {},
            maxRetriesPerRequest: null,
            enableOfflineQueue: false,
          },
          defaultJobOptions: {
            removeOnComplete: true,
            removeOnFail: 100,
          },
        };
      },
      inject: [ConfigService],
    }),
    PrismaModule,
    AuthModule,
    MessModule,
    MealsModule,
    BazaarModule,
    BillingModule,
    NotificationModule,
    SystemModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_INTERCEPTOR,
      useClass: MetricsInterceptor,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
