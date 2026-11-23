import { Module } from '@nestjs/common';
import { BazaarController } from './bazaar.controller';
import { BazaarService } from './bazaar.service';
import { DepositsService } from './deposits.service';
import { Tier2AiParserService } from './parser/tier2-ai-parser.service';
import { SmartBazaarParserService } from './parser/smart-bazaar-parser.service';
import { PatternMemoryService } from './parser/pattern-memory.service';

@Module({
  controllers: [BazaarController],
  providers: [
    BazaarService,
    DepositsService,
    Tier2AiParserService,
    SmartBazaarParserService,
    PatternMemoryService,
  ],
  exports: [
    BazaarService,
    DepositsService,
    SmartBazaarParserService,
    PatternMemoryService,
  ],
})
export class BazaarModule {}
