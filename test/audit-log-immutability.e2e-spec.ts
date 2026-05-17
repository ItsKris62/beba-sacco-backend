import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';

describe('Audit Log Immutability (e2e)', () => {
  let prisma: PrismaService;
  let testLogId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();
    
    prisma = moduleFixture.get<PrismaService>(PrismaService);

    const log = await prisma.auditLog.create({
      data: { 
        userId: 'test_user',
        action: 'TEST_INSERT', 
        ipAddress: '127.0.0.1' 
      }
    });
    testLogId = log.id;
  });

  it('should fail to UPDATE an audit log at the DB level', async () => {
    // Prisma throws P2025 (Record to update not found) because DO INSTEAD NOTHING yields 0 rows affected
    await expect(
      prisma.auditLog.update({ where: { id: testLogId }, data: { action: 'HACKED' } })
    ).rejects.toThrow(PrismaClientKnownRequestError);
  });

  it('should fail to DELETE an audit log at the DB level', async () => {
    // Same as above, DO INSTEAD NOTHING restricts the delete mapping
    await expect(
      prisma.auditLog.delete({ where: { id: testLogId } })
    ).rejects.toThrow(PrismaClientKnownRequestError);
  });
});