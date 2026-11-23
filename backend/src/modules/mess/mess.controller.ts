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
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role } from '@prisma/client';
import { CreateMessDto } from './dto/create-mess.dto';
import { JoinMessDto } from './dto/join-mess.dto';
import { TransferManagerDto } from './dto/transfer-manager.dto';
import { UpdateMessSettingsDto } from './dto/update-mess-settings.dto';
import { MessService } from './mess.service';

@ApiTags('Mess Management')
@ApiBearerAuth() // এই মডিউলের সব এপিআই-র জন্য টোকেন লাগবে
@UseGuards(JwtAuthGuard)
@Controller('mess')
export class MessController {
  constructor(private readonly messService: MessService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new mess (Creator becomes MANAGER)' })
  @ApiResponse({ status: 201, description: 'Mess created successfully.' })
  createMess(
    @Body() createMessDto: CreateMessDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.messService.createMess(createMessDto, user.id);
  }

  @Post('join')
  @ApiOperation({
    summary: 'Join an existing mess using a unique 4-digit code',
  })
  @ApiResponse({ status: 201, description: 'Joined successfully.' })
  @ApiResponse({ status: 404, description: 'Mess code not found.' })
  joinMess(
    @Body() joinMessDto: JoinMessDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.messService.joinMess(joinMessDto, user.id);
  }

  @Get('members')
  @ApiOperation({ summary: 'List all members in the current user mess' })
  @ApiResponse({ status: 200, description: 'List of members returned.' })
  getMembers(@CurrentUser() user: { id: string }) {
    return this.messService.getMembers(user.id);
  }

  @Get('current')
  @ApiOperation({
    summary:
      'Get current mess details including name, code, manager, and deadlines',
  })
  @ApiResponse({ status: 200, description: 'Current mess details returned.' })
  getMessDetails(@CurrentUser() user: { id: string }) {
    return this.messService.getMessDetails(user.id);
  }

  @Patch('settings')
  @UseGuards(RolesGuard)
  @Roles(Role.MANAGER)
  @ApiOperation({
    summary: 'Update mess name and meal deadline times (Manager Only)',
  })
  @ApiResponse({
    status: 200,
    description: 'Mess settings updated successfully.',
  })
  updateMessSettings(
    @Body() dto: UpdateMessSettingsDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.messService.updateMessSettings(dto, user.id);
  }

  @Delete('members/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.MANAGER)
  @ApiOperation({
    summary: 'Remove/kick an unwanted member from the mess (Manager Only)',
  })
  @ApiResponse({ status: 200, description: 'Member removed successfully.' })
  removeMember(
    @Param('id') memberId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.messService.removeMember(memberId, user.id);
  }

  @Post('leave')
  @ApiOperation({ summary: 'Leave current mess' })
  @ApiResponse({ status: 200, description: 'Left mess successfully.' })
  @ApiResponse({
    status: 400,
    description: 'User not in mess or manager cannot leave.',
  })
  leaveMess(@CurrentUser() user: { id: string }) {
    return this.messService.leaveMess(user.id);
  }

  @Post('transfer-manager')
  @UseGuards(RolesGuard)
  @Roles(Role.MANAGER)
  @ApiOperation({
    summary: 'Transfer manager ownership to another member (Manager Only)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Manager transferred successfully & notification sent to all members.',
  })
  transferManager(
    @Body() dto: TransferManagerDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.messService.transferManager(dto, user.id);
  }
}
