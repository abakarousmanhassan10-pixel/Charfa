import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { evaluateGoLive } from '@touma/config';
import { AppEnv, InjectEnv } from '../config';
import { RequirePlatformRole } from '../tenancy/platform-role.guard';

/** What stands between this deployment and real operation. Platform administrators only. Reports variable NAMES and booleans, never a value. */
@ApiTags('admin-go-live')
@ApiBearerAuth()
@RequirePlatformRole('SUPER_ADMIN', 'SUPPORT')
@Controller('admin/go-live')
export class GoLiveController {
  constructor(@InjectEnv() private readonly env: AppEnv) {}

  @Get()
  report() {
    return { ...evaluateGoLive(this.env), generatedAt: new Date().toISOString(), note: 'Nothing here enables anything: each real capability needs explicit authorization, verified prices and an approved budget.' };
  }
}
