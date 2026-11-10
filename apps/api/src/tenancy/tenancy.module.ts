import { Global, Module } from '@nestjs/common';
import { BusinessAccessGuard } from './business-access.guard';
import { PlatformRoleGuard } from './platform-role.guard';

@Global()
@Module({ providers: [BusinessAccessGuard, PlatformRoleGuard], exports: [BusinessAccessGuard, PlatformRoleGuard] })
export class TenancyModule {}
