import { IsOptional, IsString, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export class UpdateProfileDto {
  @ApiPropertyOptional({
    example: 'John Doe',
    description: 'Updated full name',
  })
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : undefined,
  )
  name?: string;

  @ApiPropertyOptional({
    example: '01712345678',
    description: '11-digit Bangladeshi mobile number',
  })
  @IsOptional()
  @IsString()
  @Matches(/^(?:\+88|88)?(01[3-9]\d{8})$/, {
    message:
      'Phone number must be a valid 11-digit Bangladeshi mobile number (e.g. 01712345678)',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : undefined,
  )
  phone?: string;
}
