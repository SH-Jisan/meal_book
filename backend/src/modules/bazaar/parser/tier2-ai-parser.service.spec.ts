import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Tier2AiParserService } from './tier2-ai-parser.service';

describe('Tier2AiParserService (Triple AI Cascading Failover)', () => {
  let service: Tier2AiParserService;
  let mockConfigService: { get: jest.Mock };
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === 'GROQ_API_KEY') return 'test-groq-key';
        if (key === 'GROQ_MODEL') return 'openai/gpt-oss-120b';
        if (key === 'GEMINI_API_KEY') return 'test-gemini-key';
        if (key === 'GEMINI_MODEL') return 'gemini-3.6-flash';
        if (key === 'OPENROUTER_API_KEY') return 'test-openrouter-key';
        if (key === 'OPENROUTER_MODEL') return 'liquid/lfm-2.5-2.6b:free';
        return null;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        Tier2AiParserService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<Tier2AiParserService>(Tier2AiParserService);
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it('should return 0 confidence when no API keys are configured', async () => {
    mockConfigService.get.mockReturnValue(null);
    delete process.env.GROQ_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    const res = await service.parse('alu 2kg 80');

    expect(res.engineUsed).toBe('TIER2_AI');
    expect(res.confidence).toBe(0);
    expect(res.warnings[0]).toContain('No AI API Keys configured');
  });

  it('should use Groq Cloud as Primary AI and return parsed items', async () => {
    const mockGroqResponse = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              depositAmount: 500,
              items: [
                {
                  name: 'Murgi (মুরগি)',
                  originalName: 'murgi',
                  quantity: 1,
                  unit: 'kg',
                  cost: 250,
                },
              ],
              warnings: [],
            }),
          },
        },
      ],
    };

    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockGroqResponse),
    } as unknown as Response);

    const res = await service.parse('murgi 1kg 250\njoma 500');

    expect(res.totalCost).toBe(250);
    expect(res.depositAmount).toBe(500);
    expect(res.items.length).toBe(1);
    expect(res.confidence).toBe(0.95);
  });

  it('should fallback to Gemini when Groq Cloud fails', async () => {
    // 1st call (Groq) fails with 429
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: () => Promise.resolve('Rate limit exceeded'),
      } as unknown as Response)
      // 2nd call (Gemini) succeeds
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        depositAmount: 1000,
                        items: [
                          {
                            name: 'Dim (ডিম)',
                            originalName: 'dim',
                            quantity: 12,
                            unit: 'piece',
                            cost: 150,
                          },
                        ],
                        warnings: [],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
      } as unknown as Response);

    const res = await service.parse('dim 1 dozen 150');

    expect(res.totalCost).toBe(150);
    expect(res.depositAmount).toBe(1000);
    expect(
      res.warnings.some((w) => w.includes('Primary AI (Groq) unavailable')),
    ).toBe(true);
    expect(
      res.warnings.some((w) =>
        w.includes('Parsed via Secondary Backup: Gemini'),
      ),
    ).toBe(true);
  });

  it('should fallback to OpenRouter when both Groq and Gemini fail', async () => {
    // Groq fails
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Groq Server Error'),
      } as unknown as Response)
      // Gemini fails
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: () => Promise.resolve('Gemini High Load'),
      } as unknown as Response)
      // OpenRouter succeeds
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    depositAmount: 300,
                    items: [
                      {
                        name: 'Alu (আলু)',
                        originalName: 'alu',
                        quantity: 2,
                        unit: 'kg',
                        cost: 80,
                      },
                    ],
                    warnings: [],
                  }),
                },
              },
            ],
          }),
      } as unknown as Response);

    const res = await service.parse('alu 2kg 80');

    expect(res.totalCost).toBe(80);
    expect(res.depositAmount).toBe(300);
    expect(
      res.warnings.some((w) =>
        w.includes('Parsed via Tertiary Backup: OpenRouter'),
      ),
    ).toBe(true);
  });

  it('should cleanly extract JSON with preamble or markdown fences', async () => {
    const rawContent =
      'Sure, here is the parsed bazaar result:\n```json\n' +
      JSON.stringify({
        depositAmount: 220,
        items: [
          {
            name: 'Potol (পটল)',
            originalName: 'potol',
            quantity: 1,
            unit: 'kg',
            cost: 100,
          },
        ],
        memberDeposits: [
          { memberName: 'Karim', amount: 300 },
          { memberName: 'Alif', amount: 100 },
          { memberName: 'Ami (Shopper)', amount: -180 },
        ],
        warnings: [],
      }) +
      '\n```\nI hope this helps your mess!';

    const chattyResponse = {
      choices: [
        {
          message: {
            content: rawContent,
          },
        },
      ],
    };

    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(chattyResponse),
    } as unknown as Response);

    const res = await service.parse('potol 1kg 100');

    expect(res.totalCost).toBe(100);
    expect(res.depositAmount).toBe(220);
    expect(res.memberDeposits?.length).toBe(3);
    expect(
      res.memberDeposits?.find((m) => m.memberName === 'Ami (Shopper)')?.amount,
    ).toBe(-180);
  });
});
