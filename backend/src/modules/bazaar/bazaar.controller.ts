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
import { BazaarService } from './bazaar.service';
import { DepositsService } from './deposits.service';
import { CompletePurchaseDto } from './dto/complete-purchase.dto';
import { CreateBazaarItemDto } from './dto/create-bazaar-item.dto';
import { CreateDepositDto } from './dto/create-deposit.dto';
import { SmartParseDto } from './dto/smart-parse.dto';
import { SmartSubmitDto } from './dto/smart-submit.dto';
import { RejectBazaarDto } from './dto/reject-bazaar.dto';
import { SubmitDepositRequestDto } from './dto/submit-deposit-request.dto';

@ApiTags('Bazaar & Deposits')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('bazaar')
export class BazaarController {
  constructor(
    private readonly bazaarService: BazaarService,
    private readonly depositsService: DepositsService,
  ) {}

  // -------------------------------------------------------------
  // ১. SMART NOTEPAD PREVIEW
  // -------------------------------------------------------------
  @Post('smart-parse')
  @ApiOperation({
    summary: 'Preview notepad parsing (Dual Engine: Regex + AI)',
  })
  @ApiResponse({ status: 200, description: 'Parsed structure returned.' })
  smartParse(@Body() dto: SmartParseDto, @CurrentUser() user: { id: string }) {
    return this.bazaarService.smartParse(dto, user?.id);
  }

  // -------------------------------------------------------------
  // ২. SMART NOTEPAD SUBMIT
  // -------------------------------------------------------------
  @Post('smart-submit')
  @ApiOperation({
    summary:
      'Submit parsed notepad items and deposit (Member: Pending Approval, Manager: Auto-Approved)',
  })
  @ApiResponse({ status: 201, description: 'Bazaar submitted successfully.' })
  smartSubmit(
    @Body() dto: SmartSubmitDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.bazaarService.smartSubmit(dto, user.id);
  }

  // -------------------------------------------------------------
  // ৩. APPROVE BAZAAR (MANAGER ONLY)
  // -------------------------------------------------------------
  @Patch('approve/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.MANAGER)
  @ApiOperation({
    summary: 'Approve pending bazaar item & deposit (Manager only)',
  })
  @ApiResponse({
    status: 200,
    description: 'Bazaar item approved and added to billing.',
  })
  approveBazaar(
    @Param('id') itemId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.bazaarService.approveBazaar(itemId, user.id);
  }

  // -------------------------------------------------------------
  // ৪. REJECT BAZAAR (MANAGER ONLY)
  // -------------------------------------------------------------
  @Patch('reject/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.MANAGER)
  @ApiOperation({
    summary: 'Reject pending bazaar item & deposit (Manager only)',
  })
  @ApiResponse({ status: 200, description: 'Bazaar item rejected.' })
  rejectBazaar(
    @Param('id') itemId: string,
    @Body() dto: RejectBazaarDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.bazaarService.rejectBazaar(itemId, dto, user.id);
  }

  // -------------------------------------------------------------
  // ৫. BAZAAR LIST & LEGACY ENDPOINTS
  // -------------------------------------------------------------
  @Get('list')
  @ApiOperation({ summary: 'Get current month bazaar list' })
  @ApiResponse({ status: 200, description: 'Bazaar list returned.' })
  getBazaarList(@CurrentUser() user: { id: string }) {
    return this.bazaarService.getBazaarList(user.id);
  }

  @Post('item')
  @ApiOperation({ summary: 'Add a new item to the bazaar list' })
  @ApiResponse({ status: 201, description: 'Item added successfully.' })
  createBazaarItem(
    @Body() dto: CreateBazaarItemDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.bazaarService.createBazaarItem(dto, user.id);
  }

  @Patch('complete/:id')
  @ApiOperation({ summary: 'Submit purchase cost and mark item as completed' })
  @ApiResponse({ status: 200, description: 'Purchase completed.' })
  completePurchase(
    @Param('id') itemId: string,
    @Body() dto: CompletePurchaseDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.bazaarService.completePurchase(itemId, dto, user.id);
  }

  @Delete('item/:id')
  @ApiOperation({
    summary: 'Delete unpurchased pending item from bazaar shopping list',
  })
  @ApiResponse({ status: 200, description: 'Item deleted successfully.' })
  @ApiResponse({
    status: 400,
    description: 'Cannot delete purchased or completed item.',
  })
  deleteBazaarItem(
    @Param('id') itemId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.bazaarService.deleteBazaarItem(itemId, user.id);
  }

  // -------------------------------------------------------------
  // ৬. DEPOSIT ENDPOINTS (DELEGATED TO DepositsService)
  // -------------------------------------------------------------
  @Post('deposit')
  @UseGuards(RolesGuard)
  @Roles(Role.MANAGER)
  @ApiOperation({ summary: 'Log member deposit (Manager only)' })
  @ApiResponse({ status: 201, description: 'Deposit logged successfully.' })
  addDeposit(
    @Body() dto: CreateDepositDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.depositsService.addDeposit(dto, user.id);
  }

  @Get('deposits')
  @ApiOperation({ summary: 'Get current month member deposits list' })
  @ApiResponse({ status: 200, description: 'Deposits list returned.' })
  getDeposits(@CurrentUser() user: { id: string }) {
    return this.depositsService.getDeposits(user.id);
  }

  @Post('deposit-request')
  @ApiOperation({
    summary:
      'Member submits cash/bKash deposit request for manager verification',
  })
  @ApiResponse({
    status: 201,
    description: 'Deposit request submitted and pending approval.',
  })
  submitDepositRequest(
    @Body() dto: SubmitDepositRequestDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.depositsService.submitDepositRequest(dto, user.id);
  }

  @Patch('deposit/:id/approve')
  @UseGuards(RolesGuard)
  @Roles(Role.MANAGER)
  @ApiOperation({
    summary: 'Manager approves a pending deposit request (Manager only)',
  })
  @ApiResponse({ status: 200, description: 'Deposit approved.' })
  @ApiResponse({
    status: 400,
    description: 'Deposit already processed or not pending.',
  })
  approveDeposit(
    @Param('id') depositId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.depositsService.approveDeposit(depositId, user.id);
  }

  @Patch('deposit/:id/reject')
  @UseGuards(RolesGuard)
  @Roles(Role.MANAGER)
  @ApiOperation({
    summary: 'Manager rejects a pending deposit request (Manager only)',
  })
  @ApiResponse({ status: 200, description: 'Deposit rejected.' })
  @ApiResponse({
    status: 400,
    description: 'Deposit already processed or not pending.',
  })
  rejectDeposit(
    @Param('id') depositId: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.depositsService.rejectDeposit(depositId, user.id);
  }
}
