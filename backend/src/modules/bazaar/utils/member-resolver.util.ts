import { FuzzyNormalizer } from '../parser/fuzzy-normalizer';

export interface MemberSummary {
  id: string;
  name: string;
}

export class MemberResolverUtil {
  /**
   * Resolves a member name using exact, substring, or fuzzy Levenshtein matching.
   */
  static resolveMember(
    name: string,
    members: MemberSummary[],
  ): MemberSummary | null {
    if (!name || members.length === 0) return null;
    const cleanName = name.toLowerCase().trim();

    // 1. Exact match
    const exact = members.find(
      (m) => m.name.toLowerCase().trim() === cleanName,
    );
    if (exact) return exact;

    // 2. Substring match
    const substringMatch = members.find(
      (m) =>
        m.name.toLowerCase().includes(cleanName) ||
        cleanName.includes(m.name.toLowerCase()),
    );
    if (substringMatch) return substringMatch;

    // 3. Fuzzy Levenshtein Distance (allowing up to 2 typos)
    let bestMatch: MemberSummary | null = null;
    let minDistance = 3;

    for (const m of members) {
      const dist = FuzzyNormalizer.levenshteinDistance(
        cleanName,
        m.name.toLowerCase().trim(),
      );
      if (dist < minDistance) {
        minDistance = dist;
        bestMatch = m;
      }
    }

    return bestMatch;
  }
}
