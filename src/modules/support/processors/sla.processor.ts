import { Processor, WorkerHost } from '@nestjs/bullmq';
import { PrismaService } from '../../../prisma/prisma.service';

@Processor('support-sla')
export class SlaProcessor extends WorkerHost {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process() {
    const now = new Date();
    await this.prisma.supportTicket.updateMany({
      where: {
        status: { in: ['OPEN', 'IN_PROGRESS'] },
        resolutionDueAt: { lt: now },
        priority: { not: 'CRITICAL' },
      },
      data: { priority: 'CRITICAL' },
    });
  }
}
