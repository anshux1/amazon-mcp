import { Module } from '@nitrostack/core';
import { AuthService } from './auth.service.js';
import { JWTGuard } from './jwt.guard.js';

@Module({
  name: 'auth',
  description: 'Better Auth JWT validation and trusted user resolution',
  providers: [AuthService, JWTGuard],
  exports: [AuthService, JWTGuard],
})
export class AuthModule {}
