import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class BotDefenseService {
  private readonly logger = new Logger(BotDefenseService.name);

  constructor(private configService: ConfigService) {}

  /**
   * 🛡️ ANTI-BOT DEFENSE 1: Honeypot Trap Check
   */
  verifyHoneypot(honeypot?: string, email?: string): void {
    if (honeypot && honeypot.trim().length > 0) {
      this.logger.warn(
        `🤖 BOT TRAPPED: Honeypot field filled by automated bot from email: ${email || 'unknown'}`,
      );
      throw new BadRequestException('Bot activity detected.');
    }
  }

  /**
   * 🛡️ ANTI-BOT DEFENSE 2: Cloudflare Turnstile CAPTCHA Token Verification
   */
  async verifyTurnstile(captchaToken?: string): Promise<void> {
    const turnstileSecret = this.configService.get<string>(
      'TURNSTILE_SECRET_KEY',
    );
    if (!turnstileSecret) return;

    if (!captchaToken) {
      throw new BadRequestException('Captcha token is required.');
    }

    try {
      const formData = new URLSearchParams();
      formData.append('secret', turnstileSecret);
      formData.append('response', captchaToken);
      const res = await fetch(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        {
          method: 'POST',
          body: formData,
        },
      );
      const outcome = await res.json();
      if (outcome.success !== true) {
        throw new BadRequestException(
          'Captcha verification failed. Automated bot activity suspected.',
        );
      }
    } catch (err: unknown) {
      if (err instanceof BadRequestException) {
        throw err;
      }
      this.logger.error('Turnstile verification request failed:', err);
      // Fail-safe to avoid blocking legitimate users on external network timeout
    }
  }
}
