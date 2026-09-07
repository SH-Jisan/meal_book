import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IBazaarParser, ParsedBazaarItem, ParsedBazaarResult } from './parser.interface';
import { FuzzyNormalizer } from './fuzzy-normalizer';

@Injectable()
export class Tier2AiParserService implements IBazaarParser {
  private readonly logger = new Logger(Tier2AiParserService.name);

  constructor(private configService: ConfigService) {}

  /**
   * Helper: Call Google Gemini API
   */
  private async callGemini(
    apiKey: string,
    model: string,
    systemPromptWithContext: string,
    rawText: string,
  ): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: `${systemPromptWithContext}\n\nUser Notes:\n${rawText}` }],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1,
        },
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Gemini HTTP ${response.status}: ${errBody}`);
    }

    const data = await response.json();
    const contentText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!contentText) throw new Error('Empty response from Gemini');
    return contentText;
  }

  /**
   * Helper: Call OpenAI-compatible LLM endpoints (Groq Cloud & OpenRouter)
   */
  private async callOpenAiCompatible(
    apiUrl: string,
    apiKey: string,
    model: string,
    systemPromptWithContext: string,
    rawText: string,
    providerName: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<string> {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...extraHeaders,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPromptWithContext },
          { role: 'user', content: `User Notes:\n${rawText}` },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`${providerName} HTTP ${response.status}: ${errBody}`);
    }

    const data = await response.json();
    const contentText = data?.choices?.[0]?.message?.content;
    if (!contentText) throw new Error(`Empty response from ${providerName}`);
    return contentText;
  }

  async parse(rawText: string, managerName?: string): Promise<ParsedBazaarResult> {
    const geminiKey =
      this.configService.get<string>('GEMINI_API_KEY') || process.env.GEMINI_API_KEY;
    const geminiModel =
      this.configService.get<string>('GEMINI_MODEL') ||
      process.env.GEMINI_MODEL ||
      'gemini-3.6-flash';

    const groqKey =
      this.configService.get<string>('GROQ_API_KEY') || process.env.GROQ_API_KEY;
    const groqModel =
      this.configService.get<string>('GROQ_MODEL') ||
      process.env.GROQ_MODEL ||
      'llama-3.3-70b-versatile';

    const openRouterKey =
      this.configService.get<string>('OPENROUTER_API_KEY') ||
      process.env.OPENROUTER_API_KEY;
    const openRouterModel =
      this.configService.get<string>('OPENROUTER_MODEL') ||
      process.env.OPENROUTER_MODEL ||
      'meta-llama/llama-3.3-70b-instruct:free';

    const hasAnyKey = !!(geminiKey || groqKey || openRouterKey);

    if (!hasAnyKey) {
      this.logger.warn('No AI API Keys configured (GEMINI, GROQ, or OPENROUTER). Skipping AI parse.');
      return {
        depositAmount: 0,
        items: [],
        totalCost: 0,
        rawText,
        engineUsed: 'TIER2_AI',
        confidence: 0,
        warnings: ['No AI API Keys configured in .env'],
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
     If change is returned to manager/mess (e.g. "rohim ke ferot disi 900", "manager ke disi 500"):
       Unreturned Cash Kept by Shopper = Remaining Change - Cash Returned to Manager.
     If Shopper kept unreturned cash and did NOT contribute personal money:
       The shopper took a cash advance from mess funds!
       Record a NEGATIVE deposit for the shopper in "memberDeposits":
       { "memberName": "Ami (Shopper)", "amount": -(Unreturned Cash Kept by Shopper) }
   - Net "depositAmount" = Sum of all items in "memberDeposits".

2. 💰 CASH & NET DEPOSIT RECONCILIATION WHEN SHOPPER CONTRIBUTED PERSONAL CASH:
   - When shopper contributes personal cash ("ami disi 500") and withdraws money ("ami nisi 200") or keeps change:
     Shopper Net Deposit = (Shopper's personal cash contributed) - (Shopper's personal withdrawals/change kept).

3. 🚫 PERSONAL (NON-MESS) EXPENSE FILTER:
   - If user notes personal expenses (e.g. "amar nijer sabun 80", "personal khata 50", "eta mess er na"):
     DO NOT include them in mess "items" or "totalCost"! Note them in "warnings".

4. 📏 CULTURAL UNITS & CONVERSIONS:
   - "poa" / "পোয়া" = 0.25 kg (or 250 gm), "hali" / "হালি" = 4 pieces, "dozen" / "ডজন" = 12 pieces, "kuri" = 20 pieces
   - "der kg" = 1.5 kg, "arai kg" = 2.5 kg, "adha liter" = 0.5 ltr
   - Currency: "1k" = 1000, "1.5k" = 1500, "500/=" or "500/-" = 500.

5. 💳 DUE / BAKI TO SHOPKEEPER:
   - Record full item cost, and add warning: "Due to shopkeeper: X Tk".

6. 🔤 PHONETIC BANGLISH & TYPOS:
   - "mangaer" / "managar" = Manager, "polar chaul" = Polao Chaul, "dese" / "dise" = gave, "nisi" / "nilam" = took.

### FEW-SHOT BENCHMARK EXAMPLES:

User Input:
"jisan dise 1.5k
karim dise 300
alif dise 100
murgi 5kg 1k
potol 1kg 100
chaul 1kg 100
gari vara 20
manager ke disi 500"
Output:
{
  "depositAmount": 220,
  "items": [
    { "name": "Murgi (মুরগি)", "originalName": "murgi", "quantity": 5, "unit": "kg", "cost": 1000 },
    { "name": "Potol (পটল)", "originalName": "potol", "quantity": 1, "unit": "kg", "cost": 100 },
    { "name": "Chaul (চাল)", "originalName": "chaul", "quantity": 1, "unit": "kg", "cost": 100 },
    { "name": "Gari Vara (গাড়ি ভাড়া)", "originalName": "gari vara", "quantity": 1, "unit": "trip", "cost": 20 }
  ],
  "memberDeposits": [
    { "memberName": "Karim", "amount": 300 },
    { "memberName": "Alif", "amount": 100 },
    { "memberName": "Ami (Shopper)", "amount": -180 }
  ],
  "warnings": [
    "Reconciliation: Total collected 1900 Tk (Jisan/Manager 1500 Tk + Karim 300 Tk + Alif 100 Tk). Bazaar cost 1220 Tk. Manager received 500 Tk cash return. Shopper kept 180 Tk unreturned cash (recorded as -180 Tk deposit for shopper). Total net deposit: 220 Tk."
  ]
}`;

    const managerDirective = managerName
      ? `\n### CURRENT MESS MANAGER CONTEXT:
- Current Mess Manager Name: "${managerName}".
- Any cash given by "${managerName}" (e.g. "${managerName} dise 1.5k", "${managerName} 1000", or "manager dise ...") is MESS BAZAAR CASH disbursed by the manager for shopping.
- CRITICAL INVARIANT: It is NOT "${managerName}"'s personal deposit! DO NOT add a memberDeposit entry for "${managerName}".
- When change is returned to "${managerName}" (e.g. "${managerName} ke ferot disi 500", "manager ke disi 500"), it is unspent mess cash returned to the manager fund.\n`
      : '';

    const fullPrompt = `${systemPrompt}${managerDirective}`;

    let rawJsonText: string | null = null;
    let activeAiProvider = 'NONE';
    const fallbackWarnings: string[] = [];

    // -------------------------------------------------------------
    // Tier 2A: Primary AI - Google Gemini
    // -------------------------------------------------------------
    if (geminiKey) {
      try {
        rawJsonText = await this.callGemini(geminiKey, geminiModel, fullPrompt, rawText);
        activeAiProvider = `Gemini (${geminiModel})`;
        this.logger.log(`[Tier2Ai] Successfully parsed via Primary AI: ${activeAiProvider}`);
      } catch (err: any) {
        this.logger.warn(`[Tier2Ai] Primary AI (Gemini) failed: ${err.message}. Falling back to Secondary AI (Groq)...`);
        fallbackWarnings.push(`Primary AI (Gemini) unavailable: ${err.message}`);
      }
    }

    // -------------------------------------------------------------
    // Tier 2B: Secondary AI - Groq Cloud (Ultra-Fast LPU)
    // -------------------------------------------------------------
    if (!rawJsonText && groqKey) {
      try {
        rawJsonText = await this.callOpenAiCompatible(
          'https://api.groq.com/openai/v1/chat/completions',
          groqKey,
          groqModel,
          fullPrompt,
          rawText,
          'Groq Cloud',
        );
        activeAiProvider = `Groq (${groqModel})`;
        this.logger.log(`[Tier2Ai] Successfully parsed via Secondary AI: ${activeAiProvider}`);
        fallbackWarnings.push(`Parsed via Secondary Failover: ${activeAiProvider}`);
      } catch (err: any) {
        this.logger.warn(`[Tier2Ai] Secondary AI (Groq) failed: ${err.message}. Falling back to Tertiary AI (OpenRouter)...`);
        fallbackWarnings.push(`Secondary AI (Groq) unavailable: ${err.message}`);
      }
    }

    // -------------------------------------------------------------
    // Tier 2C: Tertiary AI - OpenRouter (Universal Free Aggregator)
    // -------------------------------------------------------------
    if (!rawJsonText && openRouterKey) {
      try {
        rawJsonText = await this.callOpenAiCompatible(
          'https://openrouter.ai/api/v1/chat/completions',
          openRouterKey,
          openRouterModel,
          fullPrompt,
          rawText,
          'OpenRouter',
          {
            'HTTP-Referer': 'https://mealbook.app',
            'X-Title': 'Meal Book AI',
          },
        );
        activeAiProvider = `OpenRouter (${openRouterModel})`;
        this.logger.log(`[Tier2Ai] Successfully parsed via Tertiary AI: ${activeAiProvider}`);
        fallbackWarnings.push(`Parsed via Tertiary Failover: ${activeAiProvider}`);
      } catch (err: any) {
        this.logger.error(`[Tier2Ai] Tertiary AI (OpenRouter) failed: ${err.message}`);
        fallbackWarnings.push(`Tertiary AI (OpenRouter) unavailable: ${err.message}`);
      }
    }

    // -------------------------------------------------------------
    // If all configured AI providers failed or none responded
    // -------------------------------------------------------------
    if (!rawJsonText) {
      this.logger.error('[Tier2Ai] All AI providers (Gemini, Groq, OpenRouter) failed or unconfigured.');
      return {
        depositAmount: 0,
        items: [],
        totalCost: 0,
        rawText,
        engineUsed: 'TIER2_AI',
        confidence: 0,
        warnings: [
          'All AI engines (Gemini, Groq, OpenRouter) are currently unavailable.',
          ...fallbackWarnings,
        ],
      };
    }

    try {
      // Clean possible markdown code fences from response (e.g. ```json ... ```)
      const cleanJson = rawJsonText
        .replace(/^\s*\`\`\`(?:json)?\s*/i, '')
        .replace(/\s*\`\`\`\s*$/i, '')
        .trim();

      const parsedJson = JSON.parse(cleanJson);

      const items: ParsedBazaarItem[] = (parsedJson.items || []).map((item: any) => {
        const normalized = FuzzyNormalizer.normalize(item.originalName || item.name || 'Unknown');
        const finalName =
          item.name && item.name.includes('(')
            ? item.name
            : normalized.confidence >= 0.9
              ? normalized.canonicalName
              : item.name || normalized.canonicalName;

        return {
          name: finalName,
          originalName: item.originalName || item.name || 'Unknown',
          quantity: typeof item.quantity === 'number' && item.quantity > 0 ? item.quantity : 1,
          unit: item.unit || normalized.defaultUnit,
          cost: typeof item.cost === 'number' ? item.cost : 0,
          confidence: 0.95,
        };
      });

      const totalCost = items.reduce((sum, item) => sum + item.cost, 0);

      // Multi-member deposit parsing (supports positive contributions and negative cash deductions)
      const memberDeposits = Array.isArray(parsedJson.memberDeposits)
        ? parsedJson.memberDeposits
            .filter((m: any) => m && m.memberName && typeof m.amount === 'number' && m.amount !== 0)
            .map((m: any) => ({
              memberName: String(m.memberName).trim(),
              amount: Number(m.amount),
            }))
        : undefined;

      // Calculate total net deposit amount
      const totalDeposit =
        typeof parsedJson.depositAmount === 'number' && parsedJson.depositAmount !== 0
          ? parsedJson.depositAmount
          : memberDeposits && memberDeposits.length > 0
            ? memberDeposits.reduce((sum: number, m: { amount: number }) => sum + m.amount, 0)
            : 0;

      const mergedWarnings = [
        ...(parsedJson.warnings || []),
        ...fallbackWarnings,
      ];

      return {
        depositAmount: totalDeposit,
        items,
        totalCost,
        rawText,
        engineUsed: 'TIER2_AI',
        confidence: 0.95,
        warnings: mergedWarnings,
        memberDeposits: memberDeposits && memberDeposits.length > 0 ? memberDeposits : undefined,
      };
    } catch (err: any) {
      this.logger.error(`[Tier2Ai] JSON parsing error from ${activeAiProvider}: ${err.message}`);
      return {
        depositAmount: 0,
        items: [],
        totalCost: 0,
        rawText,
        engineUsed: 'TIER2_AI',
        confidence: 0,
        warnings: [
          `Failed to parse JSON response from ${activeAiProvider}: ${err.message}`,
          ...fallbackWarnings,
        ],
      };
    }
  }
}
