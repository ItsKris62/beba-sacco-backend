import type { Member as PrismaMember, User } from '@prisma/client';

export type Member = PrismaMember & {
  user?: Pick<User, 'firstName' | 'lastName' | 'email' | 'phone'>;
};

export interface PaginatedResponse<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
  meta: { limit: number; cursor: string | null; nextCursor: string | null; hasMore: boolean };
}
