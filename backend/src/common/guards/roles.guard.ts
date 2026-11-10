import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // ১. এপিআই রাউট বা কন্ট্রোলারে রিকোয়ার্ড রোলগুলো মেটাডাটা থেকে রিড করা
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // যদি এপিআই-তে কোনো নির্দিষ্ট রোল ডিফাইন করা না থাকে, তবে বাই-ডিফল্ট সবাই এক্সেস করতে পারবে
    if (!requiredRoles) {
      return true;
    }

    // ২. রিকোয়েস্ট অবজেক্ট থেকে লগইন করা ইউজারকে রিড করা (যা Passport পূর্বে req.user-এ বসিয়েছিল)
    const request = context
      .switchToHttp()
      .getRequest<{ user?: { role?: Role } }>();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('User session not found');
    }

    // ৩. ইউজারের রোলটি এপিআই-র রিকোয়ার্ড রোলের সাথে মিলছে কিনা চেক করা
    const hasRole = requiredRoles.some((role) => user.role === role);
    if (!hasRole) {
      throw new ForbiddenException(
        'You do not have permission to access this resource',
      );
    }

    return true;
  }
}
