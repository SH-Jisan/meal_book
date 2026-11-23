import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TokenService } from './token.service';

describe('TokenService (Unit Tests)', () => {
  let service: TokenService;

  const mockJwtService = {
    signAsync: jest.fn().mockResolvedValue('mock_token'),
    verify: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === 'JWT_ACCESS_SECRET') return 'access_secret';
      if (key === 'JWT_REFRESH_SECRET') return 'refresh_secret';
      if (key === 'JWT_ACCESS_EXPIRATION') return '15m';
      if (key === 'JWT_REFRESH_EXPIRATION') return '7d';
      return null;
    }),
  };

  const mockPrismaService = {
    user: {
      update: jest.fn().mockResolvedValue({ id: 'user_1' }),
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TokenService,
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<TokenService>(TokenService);
  });

  describe('generateTokens', () => {
    it('should generate access and refresh tokens concurrently', async () => {
      const res = await service.generateTokens(
        'user_1',
        'user@example.com',
        'MEMBER',
      );
      expect(res).toHaveProperty('accessToken', 'mock_token');
      expect(res).toHaveProperty('refreshToken', 'mock_token');
      expect(mockJwtService.signAsync).toHaveBeenCalledTimes(2);
    });
  });

  describe('hashToken', () => {
    it('should generate high-entropy SHA-256 hash', () => {
      const hash1 = service.hashToken('my_secret_token');
      const hash2 = service.hashToken('my_secret_token');
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
    });
  });

  describe('updateRefreshToken', () => {
    it('should store hashed token in user record', async () => {
      await service.updateRefreshToken('user_1', 'sample_token');
      expect(mockPrismaService.user.update).toHaveBeenCalledWith({
        where: { id: 'user_1' },
        data: { hashedRefreshToken: expect.any(String) },
      });
    });
  });

  describe('verifyRefreshToken', () => {
    it('should return payload on valid token', () => {
      mockJwtService.verify.mockReturnValueOnce({
        sub: 'user_1',
        email: 'user@example.com',
      });
      const payload = service.verifyRefreshToken('valid_token');
      expect(payload).toHaveProperty('sub', 'user_1');
    });

    it('should throw UnauthorizedException on invalid token', () => {
      mockJwtService.verify.mockImplementationOnce(() => {
        throw new Error('invalid token');
      });
      expect(() => service.verifyRefreshToken('invalid_token')).toThrow(
        UnauthorizedException,
      );
    });
  });
});
