import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RegisterDto } from './dto/register.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { Prisma } from '@prisma/client';
import { CacheKeys } from '../../common/cache/cache-keys';
import { TokenService } from './services/token.service';
import { BotDefenseService } from './services/bot-defense.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private tokenService: TokenService,
    private botDefense: BotDefenseService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {}

  // ১. মেম্বার রেজিস্ট্রেশন লজিক (Ultra Fast)
  async register(dto: RegisterDto) {
    this.botDefense.verifyHoneypot(dto.honeypot, dto.email);
    await this.botDefense.verifyTurnstile(dto.captchaToken);

    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existingUser) {
      throw new ConflictException('Email already registered');
    }

    const userId = crypto.randomUUID();
    const tokens = await this.tokenService.generateTokens(
      userId,
      dto.email,
      'MEMBER',
    );

    // ⚡ Fast SHA-256 for high-entropy Refresh Token (0.01ms CPU time)
    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const hashedRefreshToken = this.tokenService.hashToken(tokens.refreshToken);

    // ⚛️ ATOMIC PRISMA TRANSACTION: Ensure user creation and welcome notification execute atomically
    try {
      const user = await this.prisma.$transaction(async (tx) => {
        // ১. ইউজার ক্রিয়েট করা
        const newUser = await tx.user.create({
          data: {
            id: userId,
            name: dto.name,
            email: dto.email,
            phone: dto.phone,
            hashedPassword,
            hashedRefreshToken,
          },
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        });
        // ২. ইউজারের জন্য সিস্টেম ওয়েলকাম নোটিফিকেশন তৈরি করা
        await tx.notification.create({
          data: {
            userId: newUser.id,
            title: 'Welcome to Mess Manager! 🎉',
            body: `Hello ${newUser.name}, welcome to Hollaru Mess Manager. You can now join or manage your mess.`,
          },
        });
        return newUser;
      });

      return { user, ...tokens };
    } catch (error: unknown) {
      // 🛡️ RACE CONDITION DEFENSE: Catch Prisma duplicate key error P2002 cleanly
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Email address is already registered');
      }
      throw error;
    }
  }

  // ২. লগইন ভেরিফিকেশন লজিক (Ultra Fast Sub-50ms with Secure Redis Auth Cache)
  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user || !user.hashedPassword) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!dto?.password) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isPasswordValid = await bcrypt.compare(
      dto.password,
      user.hashedPassword,
    );
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const tokens = await this.tokenService.generateTokens(
      user.id,
      user.email,
      user.role,
    );

    await this.tokenService.updateRefreshToken(user.id, tokens.refreshToken);

    const {
      hashedPassword: _hashedPassword,
      hashedRefreshToken: _hashedRefreshToken,
      ...safeUser
    } = user;

    const cacheKey = CacheKeys.userProfile(dto.email);
    try {
      await this.cacheManager.set(cacheKey, safeUser, 900000);
    } catch {
      //
    }
    return { user: safeUser, ...tokens };
  }

  // 🔒 FIX DRAWBACK 1: Helper method to invalidate stale user cache when profile/password is updated
  async clearUserAuthCache(email: string) {
    try {
      await this.cacheManager.del(CacheKeys.userProfile(email));
    } catch {
      // ignore error
    }
  }

  // ৩. টোকেন রিফ্রেশ করার লজিক
  async refresh(dto: RefreshDto) {
    const payload = this.tokenService.verifyRefreshToken(dto.refreshToken);

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });

    if (!user || !user.hashedRefreshToken) {
      throw new UnauthorizedException('Access denied');
    }

    // ⚡ Fast SHA-256 Token Comparison
    const hashedInput = this.tokenService.hashToken(dto.refreshToken);
    if (hashedInput !== user.hashedRefreshToken) {
      throw new UnauthorizedException('Access denied');
    }

    const tokens = await this.tokenService.generateTokens(
      user.id,
      user.email,
      user.role,
    );
    await this.tokenService.updateRefreshToken(user.id, tokens.refreshToken);

    return tokens;
  }

  // ৪. টোকেন জেনারেশন হেল্পার মেথড (Facade Delegation)
  async generateTokens(userId: string, email: string, role: string) {
    return this.tokenService.generateTokens(userId, email, role);
  }

  // ⚡ ৫. High-Entropy SHA-256 Token Hash Helper (Facade)
  hashToken(token: string): string {
    return this.tokenService.hashToken(token);
  }

  async updateRefreshToken(userId: string, refreshToken: string) {
    return this.tokenService.updateRefreshToken(userId, refreshToken);
  }

  // 🔒 ৪.১ মেম্বার লগআউট (Access Token Blacklisting সহ)
  async logout(userId: string, email: string, accessToken?: string) {
    await Promise.all([
      this.prisma.user.update({
        where: { id: userId },
        data: { hashedRefreshToken: null },
      }),
      this.clearUserAuthCache(email),
    ]);

    if (accessToken) {
      try {
        const cleanToken = accessToken.replace('Bearer ', '').trim();
        if (cleanToken) {
          await this.cacheManager.set(
            CacheKeys.tokenBlacklist(cleanToken),
            'REVOKED',
            900000,
          );
        }
      } catch {
        // ignore
      }
    }

    this.logger.log(
      `🔒 SECURITY AUDIT: User [${userId}] (${email}) logged out.`,
    );
    return { message: 'Successfully logged out' };
  }

  // 🔒 ৪.২ সব ডিভাইস থেকে লগআউট (Logout All Devices)
  async logoutAllDevices(userId: string, email: string, accessToken?: string) {
    const revocationTimestamp = Math.floor(Date.now() / 1000);

    await Promise.all([
      this.prisma.user.update({
        where: { id: userId },
        data: { hashedRefreshToken: null },
      }),
      this.cacheManager
        .set(CacheKeys.logoutAll(userId), revocationTimestamp, 900000)
        .catch(() => {}),
      this.clearUserAuthCache(email),
    ]);

    if (accessToken) {
      try {
        const cleanToken = accessToken.replace('Bearer ', '').trim();
        if (cleanToken) {
          await this.cacheManager.set(
            CacheKeys.tokenBlacklist(cleanToken),
            'REVOKED',
            900000,
          );
        }
      } catch {
        // ignore
      }
    }

    this.logger.log(
      `🔒 SECURITY AUDIT: User [${userId}] (${email}) logged out from ALL devices.`,
    );
    return { message: 'Successfully logged out from all devices' };
  }

  // 🔒 ৫. পাসওয়ার্ড পরিবর্তন (Change Password)
  async changePassword(dto: ChangePasswordDto, userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });

    const isMatch = await bcrypt.compare(dto.oldPassword, user.hashedPassword);
    if (!isMatch) {
      throw new UnauthorizedException('Current password does not match.');
    }

    if (dto.oldPassword === dto.newPassword) {
      throw new BadRequestException(
        'New password cannot be the same as current password.',
      );
    }

    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash(dto.newPassword, salt);

    const revocationTimestamp = Math.floor(Date.now() / 1000);
    await Promise.all([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          hashedPassword,
          hashedRefreshToken: null,
        },
      }),
      this.cacheManager
        .set(CacheKeys.logoutAll(userId), revocationTimestamp, 900000)
        .catch(() => {}),
      this.clearUserAuthCache(user.email),
    ]);

    this.logger.log(`🔒 SECURITY: User [${userId}] changed their password.`);
    return { message: 'Password changed successfully. Please log in again.' };
  }

  // 👤 ৬. প্রোফাইল এডিট (Update Profile)
  async updateProfile(dto: UpdateProfileDto, userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });

    const updateData: Record<string, any> = {};
    if (dto.name) updateData.name = dto.name;
    if (dto.phone) updateData.phone = dto.phone;

    if (Object.keys(updateData).length === 0) {
      throw new BadRequestException('No valid fields provided to update.');
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: updateData,
    });

    await this.clearUserAuthCache(user.email);

    const {
      hashedPassword: _hashedPassword,
      hashedRefreshToken: _hashedRefreshToken,
      ...safeUser
    } = updatedUser;

    return {
      message: 'Profile updated successfully',
      user: safeUser,
    };
  }

  // 👤 ৭. বর্তমান লগইনকৃত ইউজারের প্রোফাইল লোড করা (Get Profile)
  async getProfile(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        messId: true,
        joinedAt: true,
        createdAt: true,
      },
    });
    return user;
  }
}
