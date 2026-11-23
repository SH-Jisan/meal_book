import { Tier1RegexParser } from './tier1-regex-parser';

describe('Tier1RegexParser (Unit Tests)', () => {
  let parser: Tier1RegexParser;

  beforeEach(() => {
    parser = new Tier1RegexParser();
  });

  describe('Cultural Unit Parsing', () => {
    it('should convert 1 poa (পোয়া) to 0.25 kg', async () => {
      const res = await parser.parse('shorisha 1 poa 60');
      expect(res.items.length).toBe(1);
      expect(res.items[0].quantity).toBe(0.25);
      expect(res.items[0].unit).toBe('kg');
      expect(res.items[0].cost).toBe(60);
    });

    it('should convert 2 poa to 0.5 kg', async () => {
      const res = await parser.parse('shorisha 2 poa 120');
      expect(res.items.length).toBe(1);
      expect(res.items[0].quantity).toBe(0.5);
      expect(res.items[0].unit).toBe('kg');
    });

    it('should convert hali (হালি) to 4 pieces', async () => {
      const res = await parser.parse('dim 1 hali 55');
      expect(res.items.length).toBe(1);
      expect(res.items[0].quantity).toBe(4);
      expect(res.items[0].unit).toBe('piece');
      expect(res.items[0].cost).toBe(55);
    });

    it('should convert 3 hali to 12 pieces', async () => {
      const res = await parser.parse('lebu 3 hali 90');
      expect(res.items.length).toBe(1);
      expect(res.items[0].quantity).toBe(12);
      expect(res.items[0].unit).toBe('piece');
    });

    it('should convert dozen (ডজন) to 12 pieces', async () => {
      const res = await parser.parse('kola 1 dozen 120');
      expect(res.items.length).toBe(1);
      expect(res.items[0].quantity).toBe(12);
      expect(res.items[0].unit).toBe('piece');
    });

    it('should convert kuri (কুড়ি) to 20 pieces', async () => {
      const res = await parser.parse('pan 1 kuri 80');
      expect(res.items.length).toBe(1);
      expect(res.items[0].quantity).toBe(20);
      expect(res.items[0].unit).toBe('piece');
    });
  });

  describe('Net Deposit Calculation', () => {
    it('should handle paired deposit & return in single line: taka disi 3000 ferot nisi 500', async () => {
      const res = await parser.parse('taka disi 3000 ferot nisi 500');
      expect(res.depositAmount).toBe(2500);
      expect(res.warnings.length).toBe(0);
    });

    it('should handle multi-line deposit and separate return line', async () => {
      const res = await parser.parse(
        'deposit 2000\nferot nisi 300\nalu 2kg 80',
      );
      expect(res.depositAmount).toBe(1700);
      expect(res.items.length).toBe(1);
    });
  });

  describe('Price Anomaly Warning', () => {
    it('should generate advisory warning when unit price is unusually high', async () => {
      const res = await parser.parse('alu 2kg 2000');
      expect(res.items.length).toBe(1);
      expect(res.warnings.some((w) => w.includes('Price Warning'))).toBe(true);
    });
  });

  describe('Strict 90% Confidence and Dynamic Items', () => {
    it('should have >= 90% confidence on clean known items', async () => {
      const res = await parser.parse('alu 2kg 70\npeyaj 1kg 90');
      expect(res.confidence).toBeGreaterThanOrEqual(0.9);
      expect(res.warnings.length).toBe(0);
    });

    it('should have < 90% confidence on unknown item without learned definition', async () => {
      const res = await parser.parse('unknownbazaargroceryxyz 2kg 100');
      expect(res.confidence).toBeLessThan(0.9);
    });

    it('should achieve >= 95% confidence when dynamic item is provided', async () => {
      const dynamicItems = [
        {
          canonicalName: 'Shorishar Tel (সরিষার তেল)',
          defaultUnit: 'ltr',
          aliases: ['shorishar tel', 'sorisha tel'],
        },
      ];
      const res = await parser.parse('shorishar tel 2ltr 440', dynamicItems);
      expect(res.confidence).toBeGreaterThanOrEqual(0.95);
      expect(res.items[0].name).toBe('Shorishar Tel (সরিষার তেল)');
    });
  });

  describe('Member Deposits and Anti-False Item Match', () => {
    it('should parse shopper deposit and contributor deposit without creating bogus food items', async () => {
      const res = await parser.parse(
        'ami disi 2000\nkorim dise 500\nalu 2kg 80',
      );

      // Shopper deposit
      expect(res.depositAmount).toBe(2000);

      // Contributor deposit
      expect(res.memberDeposits).toBeDefined();
      expect(res.memberDeposits).toHaveLength(1);
      expect(res.memberDeposits![0].memberName).toBe('korim');
      expect(res.memberDeposits![0].amount).toBe(500);

      // Real grocery items: ONLY Alu
      expect(res.items).toHaveLength(1);
      expect(res.items[0].name).toContain('Alu');
      expect(res.items[0].cost).toBe(80);
      expect(res.totalCost).toBe(80);
    });
  });
});
