import type { Member as PrismaMember, User } from '@prisma/client';

export type Member = PrismaMember & {
  user?: Pick<User, 'firstName' | 'lastName' | 'email' | 'phone'>;
};

export interface PaginatedResponse<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}
