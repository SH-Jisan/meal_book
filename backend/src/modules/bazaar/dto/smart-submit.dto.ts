import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class SmartItemDto {
  @ApiProperty({ example: 'Alu (আলু)' })
  @IsString()
  @IsNotEmpty({ message: 'Item name is required' })
  @MaxLength(100, { message: 'Item name cannot exceed 100 characters' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : '',
  )
  name: string;

  @ApiProperty({ example: 'alu', required: false })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : undefined,
  )
  originalName?: string;

  @ApiProperty({ example: 2 })
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'Quantity must be a valid number with up to 2 decimal places' },
  )
  @Min(0, { message: 'Quantity cannot be negative' })
  @Max(10000, { message: 'Quantity exceeds maximum reasonable limit' })
  quantity: number;

  @ApiProperty({ example: 'kg' })
  @IsString()
  @IsNotEmpty({ message: 'Unit is required' })
  @MaxLength(20, { message: 'Unit cannot exceed 20 characters' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : '',
  )
  unit: string;

  @ApiProperty({ example: 200 })
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'Cost must be a valid currency amount' },
  )
  @Min(0, { message: 'Cost cannot be negative' })
  @Max(500000, { message: 'Single item cost cannot exceed 500,000 BDT' })
  cost: number;
}

export class MemberDepositDto {
  @ApiProperty({ example: 'Korim' })
  @IsString()
  @IsNotEmpty({ message: 'Member name is required' })
  @MaxLength(50, { message: 'Member name cannot exceed 50 characters' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : '',
  )
  memberName: string;

  @ApiProperty({ example: 500 })
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'Deposit amount must be a valid currency amount' },
  )
  @Min(-100000, { message: 'Deposit change cannot be less than -100,000 BDT' })
  @Max(500000, { message: 'Deposit amount cannot exceed 500,000 BDT' })
  amount: number;

  @ApiProperty({
    example: '550e8400-e29b-41d4-a716-446655440000',
    required: false,
  })
  @IsOptional()
  @IsUUID('all', { message: 'userId must be a valid UUID' })
  userId?: string;
}

export class SmartSubmitDto {
  @ApiProperty({
    example: 'ami taka disi 2000\nalu 2kg 200\ndal 1kg 100\nchaul 10kg 5k',
  })
  @IsString()
  @IsNotEmpty({ message: 'Raw text is required' })
  @MaxLength(5000, { message: 'Raw text cannot exceed 5000 characters' })
  rawText: string;

  @ApiProperty({ example: 2000, required: false })
  @IsOptional()
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'Deposit amount must be a valid currency amount' },
  )
  @Min(0, { message: 'Deposit amount cannot be negative' })
  @Max(500000, { message: 'Deposit amount cannot exceed 500,000 BDT' })
  depositAmount?: number;

  @ApiProperty({ type: [SmartItemDto] })
  @IsArray()
  @ArrayMaxSize(100, { message: 'Cannot submit more than 100 items at once' })
  @ValidateNested({ each: true })
  @Type(() => SmartItemDto)
  items: SmartItemDto[];

  @ApiProperty({ type: [MemberDepositDto], required: false })
  @IsArray()
  @IsOptional()
  @ArrayMaxSize(50, {
    message: 'Cannot submit more than 50 member deposits at once',
  })
  @ValidateNested({ each: true })
  @Type(() => MemberDepositDto)
  memberDeposits?: MemberDepositDto[];
}
