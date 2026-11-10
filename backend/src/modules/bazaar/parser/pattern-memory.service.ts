import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AppCacheService } from '../../../common/cache/app-cache.service';
import { ItemDefinition } from './fuzzy-normalizer';

@Injectable()
export class PatternMemoryService {
  private readonly logger = new Logger(PatternMemoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appCache: AppCacheService,
  ) {}

  /**
   * নির্দিষ্ট মেসের জন্য এবং গ্লোবাল শেখা প্যাটার্ন লোড করা (Redis Cache-Aside সহ)
   * ক্যাশ কি: `bazaar:patterns:{messId || 'global'}`
   */
  async getLearnedItems(messId?: string): Promise<ItemDefinition[]> {
    const cacheKey = `bazaar:patterns:${messId || 'global'}`;

    return this.appCache.remember<ItemDefinition[]>(
      cacheKey,
      86400,
      async () => {
        const whereClause = messId
          ? { OR: [{ messId }, { messId: null }] }
          : { messId: null };

        const patterns = await this.prisma.learnedBazaarPattern.findMany({
          where: whereClause,
          orderBy: { hitCount: 'desc' },
          take: 200, // সর্বাধিক ব্যবহৃত শীর্ষ ২০০টি শেখা প্যাটার্ন
        });

        return patterns.map((p) => ({
          canonicalName: p.canonicalName,
          defaultUnit: p.defaultUnit,
          aliases: [p.rawPhrase.toLowerCase().trim()],
        }));
      },
    );
  }

  /**
   * নতুন কোনো আইটেম শিখলে ডাটাবেজে সেভ এবং রেডিস ক্যাশ ইনভ্যালিডেট করা
   */
  async learnPattern(
    rawPhrase: string,
    canonicalName: string,
    defaultUnit: string = 'kg',
    messId?: string,
    source: 'AI_GEMINI' | 'USER_MANUAL_CORRECTION' = 'AI_GEMINI',
  ): Promise<void> {
    const cleanPhrase = (rawPhrase || '').toLowerCase().trim();
    if (!cleanPhrase || cleanPhrase.length < 2) return;

    try {
      // ১. ডাটাবেজে আগে থেকেই এই মেসের জন্য বা গ্লোবালি শব্দটি আছে কি না দেখা
      const existing = await this.prisma.learnedBazaarPattern.findFirst({
        where: {
          rawPhrase: cleanPhrase,
          messId: messId || null,
        },
      });

      if (existing) {
        // থাকলে hitCount বাড়াবে এবং কনফিডেন্স আপডেট করবে
        await this.prisma.learnedBazaarPattern.update({
          where: { id: existing.id },
          data: {
            hitCount: { increment: 1 },
            canonicalName,
            defaultUnit,
            learnedFrom: source,
            confidence:
              source === 'USER_MANUAL_CORRECTION' ? 1.0 : existing.confidence,
          },
        });
      } else {
        // না থাকলে নতুন রেকর্ড তৈরি করবে
        await this.prisma.learnedBazaarPattern.create({
          data: {
            rawPhrase: cleanPhrase,
            canonicalName,
            defaultUnit,
            messId: messId || null,
            hitCount: 1,
            confidence: source === 'USER_MANUAL_CORRECTION' ? 1.0 : 0.95,
            learnedFrom: source,
          },
        });
      }

      // ২. সংশ্লিষ্ট রেডিস ক্যাশ ইনভ্যালিডেট করা যাতে সাথে সাথে নতুন ডাটা পাওয়া যায়
      const cacheKey = `bazaar:patterns:${messId || 'global'}`;
      await this.appCache.del(cacheKey);

      this.logger.log(
        `Learned pattern "${cleanPhrase}" -> "${canonicalName}" (${source}) for mess: ${messId || 'GLOBAL'}`,
      );
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to save learned pattern [${cleanPhrase}]: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
