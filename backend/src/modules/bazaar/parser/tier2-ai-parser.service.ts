import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IBazaarParser,
  ParsedBazaarItem,
  ParsedBazaarResult,
} from './parser.interface';
import { FuzzyNormalizer } from './fuzzy-normalizer';

@Injectable()
export class Tier2AiParserService implements IBazaarParser {
  private readonly logger = new Logger(Tier2AiParserService.name);

  constructor(private configService: ConfigService) {}

  async parse(
    rawText: string,
    managerName?: string,
  ): Promise<ParsedBazaarResult> {
    const apiKey =
      this.configService.get<string>('GEMINI_API_KEY') ||
      process.env.GEMINI_API_KEY;

    if (!apiKey) {
      this.logger.warn(
        'GEMINI_API_KEY is not configured in .env. Skipping AI parse.',
      );
      return {
        depositAmount: 0,
        items: [],
        totalCost: 0,
        rawText,
        engineUsed: 'TIER2_AI',
        confidence: 0,
        warnings: ['GEMINI_API_KEY is not configured in .env'],
      };
    }

    const systemPrompt = `You are the master financial & linguistic AI parser for a Bangladeshi dining/mess management platform (Meal Book).
Your job is to parse complex, conversational Bengali/Banglish bazaar notepad text into structured JSON with 100% financial and mathematical accuracy.

### OUTPUT JSON SCHEMA (PURE JSON ONLY, NO MARKDOWN, NO CODEBLOCKS):
{
  "depositAmount": number,
  "items": [
    {
      "name": string,
      "originalName": string,
      "quantity": number,
      "unit": string,
      "cost": number
    }
  ],
  "memberDeposits": [
    {
      "memberName": string,
      "amount": number
    }
  ],
  "warnings": string[]
}

### CRITICAL RULES FOR CALCULATION & RECONCILIATION:

1. 👥 MULTI-MEMBER CONTRIBUTIONS & SHOPPER CASH KEPT / NEGATIVE DEPOSITS (মাল্টি-মেম্বার জমা ও বাজারকারীর ক্যাশ রাখা):
   - When multiple mess members contribute money (e.g. "korim dise 500, rohim dse 500, jisun dis 1.5k"):
     Extract each contributing member into "memberDeposits" with their normalized name (e.g. "Korim", "Rohim", "Jisan") and their positive contributed amount.
   - Calculate Total Cash Collected = Sum of all contributions + Manager's cash (if any).
   - Calculate Total Bazaar Cost = Sum of all bazaar items.
   - Calculate Remaining Change = Total Cash Collected - Total Bazaar Cost.
   - SHOPPER KEPT UNRETURNED CASH (বাজারকারী যদি অবশিষ্ট ক্যাশ ফেরত না দিয়ে নিজের কাছে রাখে):
     If change is returned to manager/mess (e.g. "rohim ke ferot disi 900", "managar ke 300 ferot"):
       Unreturned Cash Kept by Shopper = Remaining Change - Cash Returned to Manager.
     If Shopper kept unreturned cash and did NOT contribute personal money:
       The shopper took a cash advance from mess funds!
       Record a NEGATIVE deposit for the shopper in "memberDeposits":
       { "memberName": "Ami (Shopper)", "amount": -(Unreturned Cash Kept by Shopper) }
       Example: Total cash 2500, Bazaar 1500, Remaining 1000. Shopper returned 900 to manager Rohim.
       Shopper kept: 1000 - 900 = 100 Tk.
       Shopper's net deposit = -100 Tk. (This ensures shopper's meal balance is debited by 100 Tk!).
   - Net "depositAmount" = Sum of all items in "memberDeposits".
     (In the above example: 500 + 500 + 1500 - 100 = 2400 Tk.
      Notice: Bazaar Cost 1500 + Cash in Manager Hand 900 = 2400 Tk! Perfectly balanced!).

2. 💰 CASH & NET DEPOSIT RECONCILIATION WHEN SHOPPER CONTRIBUTED PERSONAL CASH:
   - When shopper contributes personal cash ("ami disi 500") and withdraws money ("ami nisi 200") or keeps change:
     Shopper Net Deposit = (Shopper's personal cash contributed) - (Shopper's personal withdrawals/change kept).
   - Case Study: "mangaer amake dise 2000 taka, ami disi 500, polar chaul 5kg 1k, murgi 5kg 800, ami nisi 200, managar ke ferot dese 300/="
     - Manager gave: 2000. Shopper added: 500. Total in hand: 2500.
     - Items: 1000 + 800 = 1800.
     - Remaining cash: 2500 - 1800 = 700.
     - Shopper took back: 200. Shopper returned to manager: 300. Shopper kept remaining change: 200.
     - Total shopper kept/withdrew: 200 + 200 = 400.
     - Shopper's net contribution to mess: 500 - 400 = 100 Taka!
     - Output: depositAmount = 100.

3. 🚫 PERSONAL (NON-MESS) EXPENSE FILTER:
   - If user notes personal expenses (e.g. "amar nijer sabun 80", "personal khata 50", "eta mess er na"):
     DO NOT include them in mess "items" or "totalCost"! Note them in "warnings" (e.g. "Excluded personal item: sabun 80 Tk").

4. 📏 CULTURAL UNITS & CONVERSIONS:
   - "poa" / "পোয়া" / "পোয়া" = 0.25 kg (or 250 gm)
   - "hali" / "হালি" = 4 pieces (e.g. "der hali" = 1.5 * 4 = 6 pieces)
   - "dozen" / "ডজন" = 12 pieces (e.g. "adha dozen" = 0.5 * 12 = 6 pieces)
   - "kuri" / "কুড়ি" / "কুড়ি" = 20 pieces
   - "der kg" (দেড় কেজি) = 1.5 kg, "arai kg" (আড়াই কেজি) = 2.5 kg, "adha liter" = 0.5 ltr
   - Currency: "1k" = 1000, "1.5k" = 1500, "500/=" or "500/-" = 500, "১, ২, ৩, ০" = 1, 2, 3, 0.

5. 💳 DUE / BAKI TO SHOPKEEPER:
   - If user mentions due to shopkeeper (e.g. "bajar 2200, 200 baki ase dokandarer"):
     Record full item cost (2200), and add warning: "Due to shopkeeper: 200 Tk".

6. 🔤 PHONETIC BANGLISH & TYPOS:
   - "mangaer" / "managar" = Manager
   - "polar chaul" = Polao Chaul (পোলাওর চাল)
   - "dese" / "dise" / "dis" = gave
   - "nisi" / "nilam" = took / kept

### FEW-SHOT BENCHMARK EXAMPLES:

User Input:
"korim dise 500
rohim dse 500
jisun dis 1.5k
chal 5kg 300
murgi 5k 1k
mas 5kg 200
rohim ke ferot disi 900"
Output:
{
  "depositAmount": 2400,
  "items": [
    { "name": "Chaul (চাল)", "originalName": "chal", "quantity": 5, "unit": "kg", "cost": 300 },
    { "name": "Murgi (মুরগি)", "originalName": "murgi", "quantity": 5, "unit": "kg", "cost": 1000 },
    { "name": "Mach (মাছ)", "originalName": "mas", "quantity": 5, "unit": "kg", "cost": 200 }
  ],
  "memberDeposits": [
    { "memberName": "Korim", "amount": 500 },
    { "memberName": "Rohim", "amount": 500 },
    { "memberName": "Jisan", "amount": 1500 },
    { "memberName": "Ami (Shopper)", "amount": -100 }
  ],
  "warnings": [
    "Reconciliation: Total collected 2500 Tk. Bazaar cost 1500 Tk. Rohim received 900 Tk cash return. Shopper kept 100 Tk unreturned cash (recorded as -100 Tk deposit for shopper). Total net deposit: 2400 Tk."
  ]
}

User Input:
"mangaer amake dise 2000 taka
ami disi 500
polar chaul 5kg 1k
murgi 5kg 800
ami nisi 200
managar ke ferot dese 300/="
Output:
{
  "depositAmount": 100,
  "items": [
    { "name": "Polao Chaul (পোলাওর চাল)", "originalName": "polar chaul", "quantity": 5, "unit": "kg", "cost": 1000 },
    { "name": "Murgi (মুরগি)", "originalName": "murgi", "quantity": 5, "unit": "kg", "cost": 800 }
  ],
  "warnings": [
    "Reconciled: Shopper added 500 Tk, withdrew 400 Tk (200 during bazaar + 200 change), net deposit is 100 Tk. Manager received 300 Tk cash return."
  ]
}

User Input:
"alu 3kg 90
dim der hali 75
amar personal paste 65 tk eta mess er na
ada 1 poa 50
deposit 500 ferot nisi 220"
Output:
{
  "depositAmount": 280,
  "items": [
    { "name": "Alu (আলু)", "originalName": "alu", "quantity": 3, "unit": "kg", "cost": 90 },
    { "name": "Dim (ডিম)", "originalName": "dim", "quantity": 6, "unit": "piece", "cost": 75 },
    { "name": "Ada (আদা)", "originalName": "ada", "quantity": 0.25, "unit": "kg", "cost": 50 }
  ],
  "warnings": [
    "Excluded personal item: personal paste (65 Tk) is not counted in mess bazaar."
  ]
}`;

    const managerDirective = managerName
      ? `\n### CURRENT MESS MANAGER CONTEXT:
- Current Mess Manager Name: "${managerName}".
- Any cash given by "${managerName}" (e.g. "${managerName} dise 1.5k", "${managerName} 1000", or "manager dise ...") is MESS BAZAAR CASH disbursed by the manager for shopping.
- CRITICAL INVARIANT: It is NOT "${managerName}"'s personal deposit! DO NOT add a memberDeposit entry for "${managerName}".
- When change is returned to "${managerName}" (e.g. "${managerName} ke ferot disi 500", "manager ke disi 500"), it is unspent mess cash returned to the manager fund.\n`
      : '';

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.configService.get<string>('GEMINI_MODEL') || process.env.GEMINI_MODEL || 'gemini-3.6-flash'}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    text: `${systemPrompt}${managerDirective}\n\nUser Notes:\n${rawText}`,
                  },
                ],
              },
            ],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.1,
            },
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`Gemini API responded with status ${response.status}`);
      }

      const data = await response.json();
      const contentText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!contentText) throw new Error('Empty response from Gemini');

      const parsedJson = JSON.parse(contentText);

      const items: ParsedBazaarItem[] = (parsedJson.items || []).map(
        (item: any) => {
          const normalized = FuzzyNormalizer.normalize(
            item.originalName || item.name || 'Unknown',
          );
          const finalName =
            item.name && item.name.includes('(')
              ? item.name
              : normalized.confidence >= 0.9
                ? normalized.canonicalName
                : item.name || normalized.canonicalName;

          return {
            name: finalName,
            originalName: item.originalName || item.name || 'Unknown',
            quantity:
              typeof item.quantity === 'number' && item.quantity > 0
                ? item.quantity
                : 1,
            unit: item.unit || normalized.defaultUnit,
            cost: typeof item.cost === 'number' ? item.cost : 0,
            confidence: 0.95,
          };
        },
      );

      const totalCost = items.reduce((sum, item) => sum + item.cost, 0);

      // Multi-member deposit parsing (supports both positive and negative deposits/withdrawals)
      const memberDeposits = Array.isArray(parsedJson.memberDeposits)
        ? parsedJson.memberDeposits
            .filter(
              (m: any) =>
                m &&
                m.memberName &&
                typeof m.amount === 'number' &&
                m.amount !== 0,
            )
            .map((m: any) => ({
              memberName: String(m.memberName).trim(),
              amount: Number(m.amount),
            }))
        : undefined;

      // Calculate total net deposit amount
      const totalDeposit =
        typeof parsedJson.depositAmount === 'number' &&
        parsedJson.depositAmount !== 0
          ? parsedJson.depositAmount
          : memberDeposits && memberDeposits.length > 0
            ? memberDeposits.reduce(
                (sum: number, m: { amount: number }) => sum + m.amount,
                0,
              )
            : 0;

      return {
        depositAmount: totalDeposit,
        items,
        totalCost,
        rawText,
        engineUsed: 'TIER2_AI',
        confidence: 0.95,
        warnings: parsedJson.warnings || [],
        memberDeposits:
          memberDeposits && memberDeposits.length > 0
            ? memberDeposits
            : undefined,
      };
    } catch (err: any) {
      this.logger.error(`Tier 2 AI Parser Error: ${err.message}`);
      return {
        depositAmount: 0,
        items: [],
        totalCost: 0,
        rawText,
        engineUsed: 'TIER2_AI',
        confidence: 0,
        warnings: [`AI Parsing failed: ${err.message}`],
      };
    }
  }
}
