import { IsNotEmpty, IsNumber, IsPositive, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateDepositDto {
  @ApiProperty({ example: 'user-uuid-here' })
  @IsUUID()
  @IsNotEmpty()
  userId: string;

  @ApiProperty({ example: 2000, description: 'Deposit amount in Taka' })
  @IsNumber()
  @IsPositive({ message: 'Deposit amount must be greater than 0' })
  amount: number;
}
