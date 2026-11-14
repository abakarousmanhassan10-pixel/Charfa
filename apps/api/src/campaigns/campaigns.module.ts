import { Module } from '@nestjs/common';
import { CalendarCoreModule } from '../calendar/calendar.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { SocialCoreModule } from '../social/social.module';
import { CampaignsController } from './campaigns.controller';
import { CampaignsEnabledGuard } from './campaigns.guard';
import { CampaignsService } from './campaigns.service';

@Module({
  imports: [CalendarCoreModule, KnowledgeModule, SocialCoreModule],
  controllers: [CampaignsController],
  providers: [CampaignsService, CampaignsEnabledGuard],
  exports: [CampaignsService],
})
export class CampaignsModule {}
