import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UserRole } from '@prisma/client';
import { CreateUserDto } from './create-user.dto';

function makeDto(role: UserRole): CreateUserDto {
  return plainToInstance(CreateUserDto, {
    email: 'jane.doe@saccobank.co.ke',
    password: 'Temp@2025',
    firstName: 'Jane',
    lastName: 'Doe',
    role,
  });
}

describe('CreateUserDto — role validation', () => {
  it('rejects SUPER_ADMIN as a target role', async () => {
    const errors = await validate(makeDto(UserRole.SUPER_ADMIN));
    expect(errors.some((e) => e.property === 'role')).toBe(true);
  });

  it.each([UserRole.MEMBER, UserRole.CHAIRMAN])(
    'rejects %s as a target role — creating a brand-new User here would never get a linked Member profile',
    async (role) => {
      const errors = await validate(makeDto(role));
      expect(errors.some((e) => e.property === 'role')).toBe(true);
    },
  );

  it.each([
    UserRole.TENANT_ADMIN,
    UserRole.MANAGER,
    UserRole.LOAN_OFFICER,
    UserRole.TELLER,
    UserRole.AUDITOR,
    UserRole.ACCOUNTANT,
  ])('accepts %s as a target role', async (role) => {
    const errors = await validate(makeDto(role));
    expect(errors.some((e) => e.property === 'role')).toBe(false);
  });
});
