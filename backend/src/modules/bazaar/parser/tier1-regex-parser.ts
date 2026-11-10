import { FuzzyNormalizer, ItemDefinition } from './fuzzy-normalizer';
import {
  IBazaarParser,
  ParsedBazaarItem,
  ParsedBazaarResult,
} from './parser.interface';

export class Tier1RegexParser implements IBazaarParser {
  /**
   * বাংলা সংখ্যাকে ইংরেজি সংখ্যায় রূপান্তর (১, ২, ৩ -> 1, 2, 3)
   */
  public static convertBengaliDigits(text: string): string {
    const bengaliDigits = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
    return text.replace(/[০-৯]/g, (char) => {
      const idx = bengaliDigits.indexOf(char);
      return idx !== -1 ? String(idx) : char;
    });
  }

  /**
   * '5k' বা '1.5k' কে সংখ্যায় রূপান্তর (5k -> 5000, 1.5k -> 1500)
   */
  public static parseNumberWithMultiplier(rawNumStr: string): number {
    const clean = (rawNumStr || '').replace(/,/g, '').trim().toLowerCase();
    if (clean.endsWith('k')) {
      const baseNum = parseFloat(clean.slice(0, -1));
      return isNaN(baseNum) ? 0 : Math.round(baseNum * 1000);
    }
    const val = parseFloat(clean);
    return isNaN(val) ? 0 : val;
  }

  /**
   * কালচারাল ও স্ট্যান্ডার্ড ইউনিটকে নরম্যালাইজ করা
   * ১ পোয়া -> ০.২৫ কেজি, ১ হালি -> ৪ পিস, ১ ডজন -> ১২ পিস, ১ কুড়ি -> ২০ পিস
   */
  public static normalizeUnitAndQuantity(
    rawQuantity: number,
    rawUnit: string | null,
    defaultUnit: string,
  ): { quantity: number; unit: string } {
    let quantity = isNaN(rawQuantity) || rawQuantity <= 0 ? 1 : rawQuantity;
    let unit = (rawUnit || '').toLowerCase().trim();

    if (!unit) {
      return { quantity, unit: defaultUnit };
    }

    // কালচারাল পরিমাপ রূপান্তর
    if (
      unit === 'poa' ||
      unit === 'পোয়া' ||
      unit === 'পোয়া' ||
      unit === 'powa'
    ) {
      quantity = Number((quantity * 0.25).toFixed(3));
      unit = 'kg';
    } else if (unit === 'hali' || unit === 'হালি') {
      quantity = Math.round(quantity * 4);
      unit = 'piece';
    } else if (unit === 'dozen' || unit === 'dozon' || unit === 'ডজন') {
      quantity = Math.round(quantity * 12);
      unit = 'piece';
    } else if (unit === 'kuri' || unit === 'কুড়ি' || unit === 'কুড়ি') {
      quantity = Math.round(quantity * 20);
      unit = 'piece';
    } else if (unit === 'কেজি') {
      unit = 'kg';
    } else if (['গ্রাম', 'গ্রামস', 'gm', 'gram', 'grams'].includes(unit)) {
      unit = 'gm';
    } else if (['লিটার', 'লি', 'ltr', 'liter', 'litre'].includes(unit)) {
      unit = 'ltr';
    } else if (
      ['পিস', 'পিচ', 'টি', 'টা', 'pc', 'pcs', 'piece', 'ta', 'ti'].includes(
        unit,
      )
    ) {
      unit = 'piece';
    }

    return { quantity, unit: unit || defaultUnit };
  }

  /**
   * মূল পার্সিং ফাংশন (ডায়নামিক আইটেম সাপোর্ট সহ)
   */
  parse(
    rawText: string,
    dynamicItems: ItemDefinition[] = [],
  ): Promise<ParsedBazaarResult> {
    return Promise.resolve(this.parseSync(rawText, dynamicItems));
  }

  private parseSync(
    rawText: string,
    dynamicItems: ItemDefinition[] = [],
  ): ParsedBazaarResult {
    const lines = rawText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    let depositAmount = 0;
    const items: ParsedBazaarItem[] = [];
    const warnings: string[] = [];

    // ১. কম্বাইন্ড ডিপোজিট ও ফেরত রিজেক্স (যেমন: "taka disi 3000 ferot nisi 500", "manager dilo 2000 ferot 300")
    const combinedDepositReturnRegex =
      /(?:(?:ami\s+)?(?:taka\s+disi|taka\s+joma|deposit|joma|টাকা\s*জমা|টাকা|manager\s+(?:dilo|dise)|paisi)\s*[:=-]?\s*(\d+(?:,\d+)*(?:\.\d+)?k?)\s*(?:tk|taka|টাকা|\/-)?)\s*(?:,|\band\b|\bএবং\b|\s+|-)?\s*(?:(?:(?:ferot|pherot|ফেরত|baki|বাকি)\s*(?:nisi|nilam|nilo|dilam|disi|paisi)?|(?:nisi|nilam|nilo|dilam)\s*(?:ferot|pherot|ফেরত)?)\s*[:=-]?\s*(\d+(?:,\d+)*(?:\.\d+)?k?)\s*(?:tk|taka|টাকা|\/-)?)/i;

    // ২. শুধু ফেরত রিজেক্স (যেমন: "ferot nisi 500", "baki 200")
    const standaloneReturnRegex =
      /^(?:(?:ferot|pherot|ফেরত|baki|বাকি|change|back)\s*(?:nisi|nilam|nilo|dilam|disi)?|(?:taka\s+)?(?:ferot|ফেরত))\s*[:=-]?\s*(\d+(?:,\d+)*(?:\.\d+)?k?)\s*(?:tk|taka|টাকা|\/-)?$/i;

    // ৩. সাধারণ ডিপোজিট রিজেক্স (যেমন: "ami taka disi 2000", "deposit 1.5k")
    const depositRegex =
      /^(?:ami\s+)?(?:taka\s+disi|taka\s+joma|deposit|joma|টাকা\s*জমা|manager\s+(?:dilo|dise)|paisi|টাকা|টাকা\s+দিসি)\s*[:=-]?\s*(\d+(?:,\d+)*(?:\.\d+)?k?)\s*(?:tk|taka|টাকা|\/-)?$/i;

    // ৪. ফুল বাজার আইটেম রিজেক্স (নাম + পরিমাণ + একক + দাম)
    const unitPattern =
      '(?:kg|gm|gram|ltr|liter|litre|piece|pcs|pc|ta|ti|hali|poa|powa|dozen|dozon|kuri|কেজি|গ্রাম|লিটার|পিচ|পিস|টি|টা|পোয়া|পোয়া|হালি|ডজন|কুড়ি|কুড়ি)';
    const fullItemRegex = new RegExp(
      `^([a-zA-Z\\u0980-\\u09FF\\s]+?)\\s+(\\d+(?:\\.\\d+)?)\\s*(${unitPattern})?\\s+(\\d+(?:,\\d+)*(?:\\.\\d+)?k?)\\s*(?:tk|taka|টাকা|\\/-)?$`,
      'i',
    );

    // ৫. সিম্পল বাজার আইটেম রিজেক্স (নাম + দাম, যেমন: "dhonia pata 20", "masala 50")
    const simpleItemRegex =
      /^([a-zA-Z\u0980-\u09FF\s]+?)\s+(\d+(?:,\d+)*(?:\.\d+)?k?)\s*(?:tk|taka|টাকা|\/-)?$/i;

    for (const rawLine of lines) {
      const normalizedLine = Tier1RegexParser.convertBengaliDigits(rawLine);

      // ক. কম্বাইন্ড ডিপোজিট ও রিফান্ড চেক (Net Deposit: Given - Return)
      const combinedMatch = normalizedLine.match(combinedDepositReturnRegex);
      if (combinedMatch) {
        const given = Tier1RegexParser.parseNumberWithMultiplier(
          combinedMatch[1],
        );
        const returned = Tier1RegexParser.parseNumberWithMultiplier(
          combinedMatch[2],
        );
        depositAmount += Math.max(0, given - returned);
        continue;
      }

      // খ. স্ট্যান্ডঅ্যালোন রিফান্ড চেক (মাইনাস করা)
      const returnMatch = normalizedLine.match(standaloneReturnRegex);
      if (returnMatch) {
        const returned = Tier1RegexParser.parseNumberWithMultiplier(
          returnMatch[1],
        );
        depositAmount = Math.max(0, depositAmount - returned);
        continue;
      }

      // গ. সাধারণ ডিপোজিট চেক
      const depositMatch = normalizedLine.match(depositRegex);
      if (depositMatch) {
        depositAmount += Tier1RegexParser.parseNumberWithMultiplier(
          depositMatch[1],
        );
        continue;
      }

      // ঘ. ফুল আইটেম চেক (নাম + পরিমাণ + একক + দাম)
      const fullMatch = normalizedLine.match(fullItemRegex);
      if (fullMatch) {
        const rawItemName = fullMatch[1].trim();
        const rawQuantity = parseFloat(fullMatch[2]);
        const rawUnit = fullMatch[3] ? fullMatch[3].toLowerCase() : null;
        const cost = Tier1RegexParser.parseNumberWithMultiplier(fullMatch[4]);

        const normalized = FuzzyNormalizer.normalize(rawItemName, dynamicItems);
        const { quantity, unit } = Tier1RegexParser.normalizeUnitAndQuantity(
          rawQuantity,
          rawUnit,
          normalized.defaultUnit,
        );

        items.push({
          name: normalized.canonicalName,
          originalName: rawItemName,
          quantity,
          unit,
          cost,
          confidence: normalized.confidence,
        });
        continue;
      }

      // ঙ. সিম্পল আইটেম চেক (নাম + দাম)
      const simpleMatch = normalizedLine.match(simpleItemRegex);
      if (simpleMatch) {
        const rawItemName = simpleMatch[1].trim();
        const cost = Tier1RegexParser.parseNumberWithMultiplier(simpleMatch[2]);

        const normalized = FuzzyNormalizer.normalize(rawItemName, dynamicItems);

        items.push({
          name: normalized.canonicalName,
          originalName: rawItemName,
          quantity: 1,
          unit: normalized.defaultUnit,
          cost,
          confidence: normalized.confidence * 0.9,
        });
        continue;
      }

      // চ. কোনো প্যাটার্নেই না মিললে আনপার্সড সতর্কতা
      warnings.push(`Could not parse line: "${rawLine}"`);
    }

    // 🛡️ Zero-Typo / Price Anomaly Sanity Checks
    for (const item of items) {
      if (item.quantity > 0 && item.cost > 0) {
        const unitPrice = item.cost / item.quantity;
        const lowerName = item.name.toLowerCase();
        let isAnomaly = false;

        if (lowerName.includes('alu') && unitPrice > 250) {
          isAnomaly = true;
        } else if (lowerName.includes('dim') && unitPrice > 50) {
          isAnomaly = true;
        } else if (
          (lowerName.includes('murgi') || lowerName.includes('chicken')) &&
          unitPrice > 800
        ) {
          isAnomaly = true;
        } else if (
          (lowerName.includes('goru') || lowerName.includes('beef')) &&
          unitPrice > 2000
        ) {
          isAnomaly = true;
        } else if (lowerName.includes('dal') && unitPrice > 400) {
          isAnomaly = true;
        } else if (lowerName.includes('peyaj') && unitPrice > 350) {
          isAnomaly = true;
        } else if (lowerName.includes('chaul') && unitPrice > 250) {
          isAnomaly = true;
        } else if (
          unitPrice > 1500 &&
          item.cost >= 1000 &&
          item.cost % 100 === 0
        ) {
          isAnomaly = true;
        }

        if (isAnomaly) {
          const suggestedCost = Math.round(item.cost / 10);
          warnings.push(
            `⚠️ Price Warning: Unusually high price for ${item.name}: BDT ${item.cost} for ${item.quantity} ${item.unit} (BDT ${Math.round(unitPrice)}/${item.unit}). Did you mean BDT ${suggestedCost}?`,
          );
        }
      }
    }

    const totalCost = items.reduce((sum, item) => sum + item.cost, 0);

    // কনফিডেন্স স্কোর হিসাব (কড়া ৯০% বাউন্ডারি)
    const unparsedCount = warnings.filter((w) =>
      w.startsWith('Could not parse line:'),
    ).length;
    let overallConfidence = 0.0;

    if (items.length > 0) {
      const avgItemConfidence =
        items.reduce((sum, i) => sum + i.confidence, 0) / items.length;
      overallConfidence = Math.max(
        0.1,
        Number((avgItemConfidence - unparsedCount * 0.3).toFixed(2)),
      );
    } else if (depositAmount > 0 && unparsedCount === 0) {
      overallConfidence = 1.0;
    }

    return {
      depositAmount,
      items,
      totalCost,
      rawText,
      engineUsed: 'TIER1_REGEX',
      confidence: overallConfidence,
      warnings,
    };
  }
}
