import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MealStatus } from '@prisma/client';
import { MealType } from './update-meal.dto';

export class UpdateMealStatusDto {
  @ApiProperty({ example: 'LUNCH', enum: MealType })
  @IsEnum(MealType)
  type: MealType;

  @ApiProperty({ example: 'COOKING', enum: MealStatus })
  @IsEnum(MealStatus)
  status: MealStatus;
}
