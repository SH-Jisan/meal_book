import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
  Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export class RegisterDto {
  @ApiProperty({
    example: 'John Doe',
    description: 'Full name of the mess member',
  })
  @IsNotEmpty({ message: 'Name is required' })
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : '',
  )
  name: string;

  @ApiProperty({
    example: 'john@example.com',
    description: 'Unique email address',
  })
  @IsNotEmpty({ message: 'Email is required' })
  @IsEmail({}, { message: 'Invalid email format' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : '',
  )
  email: string;

  @ApiProperty({
    example: '01712345678',
    description: 'Bangladeshi 11-digit phone number',
  })
  @IsNotEmpty({ message: 'Phone number is required' })
  @IsString()
  @Matches(/^(?:\+88|88)?(01[3-9]\d{8})$/, {
    message:
      'Phone number must be a valid 11-digit Bangladeshi mobile number (e.g. 01712345678)',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : '',
  )
  phone: string;

  @ApiProperty({
    example: 'password123',
    description: 'Password (min 6 characters)',
  })
  @IsNotEmpty({ message: 'Password is required' })
  @MinLength(6, { message: 'Password must be at least 6 characters long' })
  password: string;

  @ApiPropertyOptional({
    example: '0x4AAAAAA...',
    description: 'Cloudflare Turnstile / reCAPTCHA Token',
  })
  @IsOptional()
  @IsString()
  captchaToken?: string;

  @ApiPropertyOptional({
    example: '',
    description: 'Hidden honeypot trap field for anti-bot defense',
  })
  @IsOptional()
  @IsString()
  honeypot?: string;
}
