import { Module } from '@nestjs/common';
import { SalesModule } from '../sales/sales.module';
import { AdminController } from './admin.controller';
import { OpsController } from './ops.controller';
import { OpsService } from './ops.service';

@Module({ imports: [SalesModule], controllers: [AdminController, OpsController], providers: [OpsService] })
export class AdminModule {}
