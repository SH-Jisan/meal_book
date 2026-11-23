import {
  Controller,
  Get,
  Header,
  MessageEvent,
  Post,
  Sse,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import * as fs from 'fs';
import * as path from 'path';
import { SystemService } from './system.service';
import { MetricsInterceptor } from '../../common/interceptors/metrics.interceptors';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '@prisma/client';

@ApiTags('System & Health Status')
@Controller('system')
export class SystemController {
  constructor(private readonly systemService: SystemService) {}

  @Get('status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Get live system memory, CPU, uptime, and DB metrics (Manager only)',
  })
  @ApiResponse({
    status: 200,
    description: 'Live system status metrics returned successfully',
  })
  getSystemStatus() {
    return this.systemService.getSystemMetrics();
  }

  @Post('cache/clear')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Manually invalidate system Redis caches (Manager only)',
  })
  clearCache() {
    return this.systemService.clearSystemCache('ALL');
  }

  @Post('queue/retry')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Retry failed BullMQ queue jobs (Manager only)',
  })
  retryQueue() {
    return this.systemService.retryFailedQueueJobs();
  }

  @Get('dashboard')
  @Header('Content-Type', 'text/html')
  @ApiOperation({
    summary: 'View Live System Status & API Performance Dashboard UI',
  })
  getDashboardUi(): string {
    return this.readFile('dashboard.html');
  }

  @Sse('events')
  @ApiOperation({
    summary:
      'Stream live real-time metrics updates via Server-Sent Events (SSE)',
  })
  streamMetrics(): Observable<MessageEvent> {
    return MetricsInterceptor.getMetricsObservable().pipe(
      map((data) => ({ data: JSON.stringify(data) })),
    );
  }

  @Get('dashboard.css')
  @Header('Content-Type', 'text/css')
  getDashboardCss(): string {
    return this.readFile('dashboard.css');
  }

  @Get('dashboard.js')
  @Header('Content-Type', 'application/javascript')
  getDashboardJs(): string {
    return this.readFile('dashboard.js');
  }

  private readFile(fileName: string): string {
    const candidatePaths = [
      path.join(
        process.cwd(),
        'src',
        'modules',
        'system',
        'dashboard_ui',
        fileName,
      ),
      path.join(__dirname, 'dashboard_ui', fileName),
      path.join(
        process.cwd(),
        'dist',
        'modules',
        'system',
        'dashboard_ui',
        fileName,
      ),
      path.join(
        process.cwd(),
        'dist',
        'src',
        'modules',
        'system',
        'dashboard_ui',
        fileName,
      ),
    ];

    const filePath = candidatePaths.find((p) => fs.existsSync(p));
    if (!filePath) {
      throw new Error(`Dashboard asset file not found: ${fileName}`);
    }
    return fs.readFileSync(filePath, 'utf8');
  }
}
