import { Module } from '@nitrostack/core';
import { AuthService } from './auth.service.js';
import { JWTGuard } from './jwt.guard.js';
import { ScopeGuard } from './scope.guard.js';

@Module({
  name: 'auth',
  description: 'Better Auth JWT validation and trusted user resolution',
  providers: [AuthService, JWTGuard, ScopeGuard],
  exports: [AuthService, JWTGuard, ScopeGuard],
})
export class AuthModule {}
