import { IsNumber, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CompletePurchaseDto {
  @ApiProperty({ example: 1550.5, description: 'Actual cost in Taka' })
  @IsNumber()
  @Min(0)
  cost: number;
}
