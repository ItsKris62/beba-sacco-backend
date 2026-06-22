import { Processor, WorkerHost } from '@nestjs/bullmq';
import { PrismaService } from '../../../prisma/prisma.service';

@Processor('support-auto-close')
export class AutoCloseTicketsProcessor extends WorkerHost {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process() {
    // 48 hours ago
    const threshold = new Date(Date.now() - 48 * 60 * 60 * 1000);

    // Prisma $queryRaw for raw performance
    await this.prisma.$executeRaw`
      UPDATE "SupportTicket"
      SET "status" = 'CLOSED', "updatedAt" = NOW()
      WHERE "status" = 'RESOLVED' 
      AND "updatedAt" < ${threshold}
    `;
  }
}
