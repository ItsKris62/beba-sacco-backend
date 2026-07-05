import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UserRole } from '@prisma/client';
import { UpdateUserDto } from './update-user.dto';

function makeDto(role: UserRole): UpdateUserDto {
  return plainToInstance(UpdateUserDto, { role });
}

describe('UpdateUserDto — role validation', () => {
  it('rejects SUPER_ADMIN as a target role', async () => {
    const errors = await validate(makeDto(UserRole.SUPER_ADMIN));
    expect(errors.some((e) => e.property === 'role')).toBe(true);
  });

  it.each([
    UserRole.TENANT_ADMIN,
    UserRole.MANAGER,
    UserRole.LOAN_OFFICER,
    UserRole.TELLER,
    UserRole.AUDITOR,
    UserRole.MEMBER,
    UserRole.CHAIRMAN,
    UserRole.ACCOUNTANT,
  ])('accepts %s as a target role', async (role) => {
    const errors = await validate(makeDto(role));
    expect(errors.some((e) => e.property === 'role')).toBe(false);
  });
});
