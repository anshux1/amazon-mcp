import { Module } from '@nitrostack/core';
import { DatabaseModule } from '../../database/database.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { CartResources } from './cart.resources.js';
import { CartService } from './cart.service.js';
import { CartTools } from './cart.tools.js';

@Module({
  name: 'cart',
  description: 'Authenticated shopping cart operations backed by the database',
  imports: [DatabaseModule, AuthModule],
  controllers: [CartTools, CartResources],
  providers: [CartService],
  exports: [CartService],
})
export class CartModule {}
