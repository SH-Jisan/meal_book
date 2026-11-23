import { IsOptional, IsString, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateMessSettingsDto {
  @ApiPropertyOptional({ example: 'Dream Heaven Mess' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({
    example: '17:00',
    description: 'HH:MM 24-hour format when requests open',
  })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
    message: 'Time must be in HH:MM 24-hour format (e.g. 17:00)',
  })
  requestStartTime?: string;

  @ApiPropertyOptional({
    example: '11:00',
    description: 'HH:MM 24-hour format',
  })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
    message: 'Time must be in HH:MM 24-hour format (e.g. 11:00)',
  })
  lunchEndTime?: string;

  @ApiPropertyOptional({
    example: '17:00',
    description: 'HH:MM 24-hour format',
  })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
    message: 'Time must be in HH:MM 24-hour format (e.g. 17:00)',
  })
  dinnerEndTime?: string;
}
