import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Request } from 'express';
import { CacheKeys } from '../../../common/cache/cache-keys';
import { User } from '@prisma/client';

export type SafeUser = Omit<User, 'hashedPassword' | 'hashedRefreshToken'>;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    configService: ConfigService,
    private prisma: PrismaService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        (req: Request) =>
          (req?.cookies as Record<string, string> | undefined)?.accessToken ||
          null,
      ]),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_ACCESS_SECRET') as string,
      passReqToCallback: true, // 👈 req অবজেক্ট পাওয়ার জন্য
    });
  }

  async validate(
    req: Request,
    payload: { sub: string; email: string; role?: string; iat?: number },
  ): Promise<SafeUser> {
    // ⚡ 1. Check if Access Token is Blacklisted in Redis
    const token =
      ExtractJwt.fromAuthHeaderAsBearerToken()(req) ||
      (req?.cookies as Record<string, string> | undefined)?.accessToken;
    if (token) {
      try {
        const isBlacklisted = await this.cacheManager.get(
          CacheKeys.tokenBlacklist(token),
        );
        if (isBlacklisted) {
          throw new UnauthorizedException('Token has been revoked/logged out');
        }
      } catch (err: unknown) {
        if (err instanceof UnauthorizedException) throw err;
      }
    }

    // ⚡ ২. Global Logout-All Devices Timestamp Check (All Devices Instant Invalidation)
    if (payload.iat) {
      try {
        const logoutAllTime = await this.cacheManager.get<number>(
          CacheKeys.logoutAll(payload.sub),
        );
        if (logoutAllTime && payload.iat <= logoutAllTime) {
          throw new UnauthorizedException(
            'Session has been revoked by logout-all from another device',
          );
        }
      } catch (err: unknown) {
        if (err instanceof UnauthorizedException) throw err;
      }
    }

    const cacheKey = CacheKeys.userProfile(payload.email);

    let user: SafeUser | null = null;
    try {
      user = (await this.cacheManager.get<SafeUser>(cacheKey)) ?? null;
    } catch {
      user = null;
    }

    if (!user) {
      const dbUser = await this.prisma.user.findUnique({
        where: { id: payload.sub },
      });

      if (!dbUser) {
        throw new UnauthorizedException('User no longer exists');
      }
      const {
        hashedPassword: _hashedPassword,
        hashedRefreshToken: _hashedRefreshToken,
        ...safeUser
      } = dbUser;
      user = safeUser;
      try {
        await this.cacheManager.set(cacheKey, user, 900000);
      } catch {
        // ignore error
      }
    }

    return user;
  }
}
