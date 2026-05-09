import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LoginDto } from '../dto/login.dto';

describe('LoginDto', () => {
  async function validateLogin(email: string) {
    const dto = plainToInstance(LoginDto, {
      email,
      password: 'TempPass123!',
    });

    return { dto, errors: await validate(dto) };
  }

  it('accepts a normal user email', async () => {
    const { errors } = await validateLogin('member@beba-sacco.com');

    expect(errors).toHaveLength(0);
  });

  it('accepts an imported system-generated email', async () => {
    const { errors } = await validateLogin('john.doe.123456@import.local');

    expect(errors).toHaveLength(0);
  });

  it('accepts and normalizes an onboarding system-generated email', async () => {
    const { dto, errors } = await validateLogin(' Member.12345678@586C1886.beba.local ');

    expect(errors).toHaveLength(0);
    expect(dto.email).toBe('member.12345678@586c1886.beba.local');
  });
});