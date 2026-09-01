import { Module } from '@nitrostack/core';
import { DatabaseModule } from '../../database/database.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { CartModule } from '../cart/cart.module.js';
import { ProductsModule } from '../products/products.module.js';
import { OrdersResources } from './orders.resources.js';
import { OrdersService } from './orders.service.js';
import { OrdersTools } from './orders.tools.js';

@Module({
  name: 'orders',
  description: 'Live-price checkout and authenticated order lifecycle',
  imports: [DatabaseModule, AuthModule, CartModule, ProductsModule],
  controllers: [OrdersTools, OrdersResources],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
