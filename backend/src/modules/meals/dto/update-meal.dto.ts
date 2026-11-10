import { IsEnum, IsInt, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export enum MealType {
  LUNCH = 'LUNCH',
  DINNER = 'DINNER',
}

export enum RequestCategory {
  OFF = 'OFF',
  GUEST = 'GUEST',
}

export class UpdateMealDto {
  @ApiProperty({ example: 'LUNCH', enum: MealType })
  @IsEnum(MealType)
  type: MealType;

  @ApiProperty({ example: 'OFF', enum: RequestCategory })
  @IsEnum(RequestCategory)
  category: RequestCategory;

  @ApiProperty({
    example: 1,
    description: 'Count to decrement (OFF) or increment (GUEST)',
  })
  @IsInt()
  @Min(1)
  count: number;
}
