import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/exceptions/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  // 🛡️ Global Security & Performance Middlewares
  app.use(helmet());
  app.use(cookieParser());
  app.use(compression());

  // ১. CORS সচল করা
  app.enableCors();

  // ২. গ্লোবাল ডাটা ভ্যালিডেশন পাইপ যুক্ত করা
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // ৩. গ্লোবাল ইন্টারসেপ্টর এবং ফিল্টার যুক্ত করা
  app.useGlobalInterceptors(new TransformInterceptor());
  app.useGlobalFilters(new HttpExceptionFilter());

  // ৪. Swagger API Documentation সেটআপ করা
  const config = new DocumentBuilder()
    .setTitle('Meal Book API')
    .setDescription('The Meal Book Mess and Dining Manager API documentation')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  // ৫. এনভায়রনমেন্ট কনফিগারেশনের পোর্ট রিড ও সার্ভার লিসেন করা
  const port = configService.get<number>('PORT') || 3000;
  await app.listen(port);

  // 🎨 প্রফেশনাল ও সুন্দর টার্মিনাল স্টার্টআপ ব্যানার
  console.log('\n');
  logger.log(`=======================================================`);
  logger.log(` 🍲 MEAL BOOK BACKEND SERVER STARTED SUCCESSFULLY 🍲 `);
  logger.log(`=======================================================`);
  logger.log(` 🚀 Server Listening  : http://localhost:${port}`);
  logger.log(` 📚 Swagger API Docs   : http://localhost:${port}/api/docs`);
  logger.log(
    ` 📊 Metrics Dashboard  : http://localhost:${port}/system/dashboard`,
  );
  logger.log(` ⚡ Health Check API   : http://localhost:${port}/system/status`);
  logger.log(`=======================================================\n`);
}
void bootstrap();
