import { SetMetadata } from '@nestjs/common';

/**
 * Public Decorator
 * 
 * Marks routes that should skip JWT authentication
 * 
 * Usage:
 * @Public()
 * @Post('login')
 * async login(@Body() loginDto: LoginDto) { ... }
 * 
 * Works in conjunction with JwtAuthGuard
 * 
 * TODO: Phase 1 - Implement JwtAuthGuard to respect this decorator
 */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

