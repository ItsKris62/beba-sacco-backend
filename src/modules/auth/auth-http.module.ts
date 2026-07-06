import { Module } from '@nestjs/common';
import { AuthModule } from './auth.module';
import { AuthController } from './auth.controller';
import { SessionController } from './session.controller';
import { TwoFactorController } from './two-factor.controller';

@Module({
  imports: [AuthModule],
  controllers: [AuthController, SessionController, TwoFactorController],
})
export class AuthHttpModule {}