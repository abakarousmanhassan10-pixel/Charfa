import { Module } from '@nestjs/common';
import { SalesModule } from '../sales/sales.module';
import { AdminController } from './admin.controller';

@Module({ imports: [SalesModule], controllers: [AdminController] })
export class AdminModule {}
