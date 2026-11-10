import { Global, Module } from '@nestjs/common';
import { ProductCategoriesController, ServiceCategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';

@Global()
@Module({ controllers: [ProductCategoriesController, ServiceCategoriesController], providers: [CategoriesService], exports: [CategoriesService] })
export class CategoriesModule {}
