import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthService } from './auth.service';

describe('AuthService (Unit Tests)', () => {
  let service: AuthService;
  let prisma: PrismaService;

  const mockPrismaService: any = {
    $transaction: jest.fn((callback) => callback(mockPrismaService)),
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    notification: {
      create: jest.fn().mockResolvedValue({}),
    },
  };

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

  const mockCacheManager = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: CACHE_MANAGER, useValue: mockCacheManager },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    prisma = module.get<PrismaService>(PrismaService);
    jest.clearAllMocks();
  });

  describe('register', () => {
    it('should throw ConflictException if email is already registered', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'user_1',
        email: 'test@test.com',
      });

      await expect(
        service.register({
          name: 'Test User',
          email: 'test@test.com',
          password: 'Password123!',
          phone: '01700000000',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should register user successfully and return tokens', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);
      mockPrismaService.user.create.mockResolvedValue({
        id: 'user_1',
        name: 'Test User',
        email: 'test@test.com',
        role: 'MANAGER',
      });
      mockPrismaService.user.update.mockResolvedValue({});

      const result = await service.register({
        name: 'Test User',
        email: 'test@test.com',
        password: 'Password123!',
        phone: '01700000000',
      });

      expect(result).toHaveProperty('user');
      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
    });
    it('should throw BadRequestException if TURNSTILE_SECRET_KEY is set and captchaToken is missing', async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'TURNSTILE_SECRET_KEY') return 'mock_turnstile_secret';
        return null;
      });

      await expect(
        service.register({
          name: 'Bot User',
          email: 'bot@test.com',
          password: 'Password123!',
          phone: '01700000000',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('login', () => {
    it('should throw UnauthorizedException if user not found', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);

      await expect(
        service.login({
          email: 'wrong@test.com',
          password: 'Password123!',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException if password does not match', async () => {
      const hashedPassword = await bcrypt.hash('CorrectPassword123!', 10);
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'user_1',
        email: 'test@test.com',
        hashedPassword,
      });

      await expect(
        service.login({
          email: 'test@test.com',
          password: 'WrongPassword123!',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should successfully login and NEVER leak hashedPassword in response or Redis cache', async () => {
      const rawPassword = 'CorrectPassword123!';
      const hashedPassword = await bcrypt.hash(rawPassword, 10);
      const hashedRefreshToken = 'old_hashed_refresh_token';

      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'user_1',
        name: 'Safe User',
        email: 'safe@test.com',
        role: 'MEMBER',
        hashedPassword,
        hashedRefreshToken,
      });
      mockPrismaService.user.update.mockResolvedValue({});

      const result = await service.login({
        email: 'safe@test.com',
        password: rawPassword,
      });

      // 🔒 1. Result user must NOT contain secrets
      expect(result.user).toBeDefined();
      expect((result.user as any).hashedPassword).toBeUndefined();
      expect((result.user as any).hashedRefreshToken).toBeUndefined();
      expect(result.user.email).toBe('safe@test.com');
      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');

      // 🔒 2. Redis cache warmed payload must NOT contain secrets
      expect(mockCacheManager.set).toHaveBeenCalled();
      const cachedPayload = mockCacheManager.set.mock.calls[0][1];
      expect(cachedPayload.hashedPassword).toBeUndefined();
      expect(cachedPayload.hashedRefreshToken).toBeUndefined();
      expect(cachedPayload.email).toBe('safe@test.com');
    });
  });

  describe('changePassword', () => {
    it('should change password successfully when old password matches', async () => {
      const oldRaw = 'OldPassword123!';
      const hashedPassword = await bcrypt.hash(oldRaw, 10);
      mockPrismaService.user.findUniqueOrThrow = jest.fn().mockResolvedValue({
        id: 'user_1',
        email: 'test@test.com',
        hashedPassword,
      });
      mockPrismaService.user.update = jest.fn().mockResolvedValue({});

      const result = await service.changePassword(
        { oldPassword: oldRaw, newPassword: 'NewPassword456!' },
        'user_1',
      );

      expect(result).toHaveProperty(
        'message',
        'Password changed successfully. Please log in again.',
      );
      expect(mockPrismaService.user.update).toHaveBeenCalled();
    });

    it('should throw UnauthorizedException when old password is wrong', async () => {
      const hashedPassword = await bcrypt.hash('DifferentPassword123!', 10);
      mockPrismaService.user.findUniqueOrThrow = jest.fn().mockResolvedValue({
        id: 'user_1',
        email: 'test@test.com',
        hashedPassword,
      });

      await expect(
        service.changePassword(
          { oldPassword: 'WrongOldPassword', newPassword: 'NewPassword456!' },
          'user_1',
        ),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('updateProfile', () => {
    it('should update user name and phone successfully', async () => {
      mockPrismaService.user.findUniqueOrThrow = jest.fn().mockResolvedValue({
        id: 'user_1',
        email: 'test@test.com',
      });
      mockPrismaService.user.update = jest.fn().mockResolvedValue({
        id: 'user_1',
        name: 'Updated Name',
        phone: '01712345678',
        email: 'test@test.com',
        hashedPassword: 'hashed',
        hashedRefreshToken: 'hashed_rt',
      });

      const result = await service.updateProfile(
        { name: 'Updated Name', phone: '01712345678' },
        'user_1',
      );

      expect(result.user.name).toBe('Updated Name');
      expect((result.user as any).hashedPassword).toBeUndefined();
    });
  });

  describe('getProfile', () => {
    it('should return safe user profile', async () => {
      mockPrismaService.user.findUniqueOrThrow = jest.fn().mockResolvedValue({
        id: 'user_1',
        name: 'Jisan',
        email: 'test@test.com',
        phone: '01712345678',
        role: 'MEMBER',
        messId: 'mess_1',
        joinedAt: new Date(),
        createdAt: new Date(),
      });

      const profile = await service.getProfile('user_1');
      expect(profile).toHaveProperty('id', 'user_1');
      expect(profile).toHaveProperty('name', 'Jisan');
      expect(profile).toHaveProperty('role', 'MEMBER');
      expect(profile).not.toHaveProperty('hashedPassword');
    });
  });
});
