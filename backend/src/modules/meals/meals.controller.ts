import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '@prisma/client';
import { UpdateMealDto } from './dto/update-meal.dto';
import { UpdateMealStatusDto } from './dto/update-meal-status.dto';
import { MealsService } from './meals.service';
import { MealRequestsService } from './meal-requests.service';

@ApiTags('Daily Meals')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('meals')
export class MealsController {
  constructor(
    private readonly mealsService: MealsService,
    private readonly mealRequestsService: MealRequestsService,
  ) {}

  @Post('request')
  @ApiOperation({
    summary: 'Submit a request to turn meal OFF or add GUEST meals',
  })
  @ApiResponse({ status: 201, description: 'Request successfully submitted.' })
  @ApiResponse({
    status: 400,
    description: 'Deadline passed or month summary not active.',
  })
  requestMealUpdate(
    @Body() dto: UpdateMealDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.mealRequestsService.requestMealUpdate(dto, user.id);
  }

  @Patch('approve/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.MANAGER)
  @ApiOperation({
    summary:
      'Manager approves a pending meal modification request (Manager only)',
  })
  @ApiResponse({
    status: 200,
    description: 'Request approved and count updated.',
  })
  @ApiResponse({
    status: 400,
    description:
      'Only managers can approve requests or request already processed.',
  })
  approveRequest(
    @Param('id') requestId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.mealRequestsService.approveRequest(requestId, user.id);
  }

  @Patch('reject/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.MANAGER)
  @ApiOperation({
    summary:
      'Manager rejects a pending meal modification request (Manager only)',
  })
  @ApiResponse({
    status: 200,
    description: 'Request rejected successfully.',
  })
  @ApiResponse({
    status: 400,
    description:
      'Only managers can reject requests or request already processed.',
  })
  rejectRequest(
    @Param('id') requestId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.mealRequestsService.rejectRequest(requestId, user.id);
  }

  @Get('pending-requests')
  @UseGuards(RolesGuard)
  @Roles(Role.MANAGER)
  @ApiOperation({
    summary:
      'Manager views all pending meal modification requests across current month (Manager only)',
  })
  @ApiResponse({
    status: 200,
    description: 'Pending requests returned.',
  })
  getPendingRequests(@CurrentUser() user: { id: string }) {
    return this.mealRequestsService.getPendingRequests(user.id);
  }

  @Patch('status')
  @UseGuards(RolesGuard)
  @Roles(Role.MANAGER)
  @ApiOperation({
    summary:
      'Manager updates today meal status to OPEN, COOKING, or CANCELLED (Manager only)',
  })
  @ApiResponse({
    status: 200,
    description: 'Meal status updated successfully.',
  })
  updateMealStatus(
    @Body() dto: UpdateMealStatusDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.mealsService.updateMealStatus(dto, user.id);
  }

  @Get('live')
  @ApiOperation({ summary: 'Get live meal counts and requests list for today' })
  @ApiResponse({ status: 200, description: 'Live count returned.' })
  getDailyLiveCount(@CurrentUser() user: { id: string }) {
    return this.mealsService.getDailyLiveCount(user.id);
  }

  @Delete('request/:id')
  @ApiOperation({
    summary: 'Member cancels their own pending meal request before deadline',
  })
  @ApiResponse({
    status: 200,
    description: 'Meal request cancelled successfully.',
  })
  @ApiResponse({
    status: 400,
    description: 'Deadline passed, unauthorized, or request already processed.',
  })
  cancelMealRequest(
    @Param('id') requestId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.mealRequestsService.cancelMealRequest(requestId, user.id);
  }

  @Get('date/:date')
  @ApiOperation({
    summary:
      'View daily meal log and all member requests for a specific date (YYYY-MM-DD)',
  })
  @ApiResponse({
    status: 200,
    description: 'Daily log and requests for the specific date returned.',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid date format or no active month session.',
  })
  getDailyLogByDate(
    @Param('date') date: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.mealsService.getDailyLogByDate(date, user.id);
  }
}
