import {
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SubmitDepositRequestDto {
  @ApiProperty({ example: 2000, description: 'Amount deposited in Taka' })
  @IsNumber()
  @IsPositive({ message: 'Deposit amount must be greater than 0' })
  amount: number;

  @ApiPropertyOptional({
    example: 'Sent via bKash, TrxID: 9X8Y7Z',
    description: 'Optional deposit note / reference',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}
