import { IsNotEmpty, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ChangePasswordDto {
  @ApiProperty({
    example: 'oldPassword123',
    description: 'Current account password',
  })
  @IsNotEmpty({ message: 'Current password is required' })
  @IsString()
  oldPassword: string;

  @ApiProperty({
    example: 'newSecurePassword456',
    description: 'New password (min 6 characters)',
  })
  @IsNotEmpty({ message: 'New password is required' })
  @MinLength(6, { message: 'New password must be at least 6 characters long' })
  @IsString()
  newPassword: string;
}
