import { Module } from '@nestjs/common';
import { MealsController } from './meals.controller';
import { MealsService } from './meals.service';
import { MealRequestsService } from './meal-requests.service';

@Module({
  controllers: [MealsController],
  providers: [MealsService, MealRequestsService],
  exports: [MealsService, MealRequestsService],
})
export class MealsModule {}
