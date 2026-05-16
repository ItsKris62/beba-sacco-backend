import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../integrations/notifications/notifications.service';
import { addDays, startOfDay, endOfDay } from 'date-fns';

@Injectable()
export class RepaymentReminderService {
  private readonly logger = new Logger(RepaymentReminderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Runs daily at midnight to find loans approaching their due date (exactly 3 days away)
   * and sends an IN_APP notification.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async processUpcomingRepayments() {
    this.logger.log('Starting daily repayment reminder check...');

    // We want exactly 3 days from now
    const targetDate = addDays(new Date(), 3);
    const startOfTarget = startOfDay(targetDate);
    const endOfTarget = endOfDay(targetDate);

    // Find active loans due in exactly 3 days
    // Assuming 'dueDate' on Loan model marks the next installment date or final due date
    const loans = await this.prisma.loan.findMany({
      where: {
        status: 'ACTIVE',
        dueDate: {
          gte: startOfTarget,
          lte: endOfTarget,
        },
      },
      include: {
        member: {
          include: {
            user: true,
          },
        },
      },
    });

    this.logger.log(`Found ${loans.length} loans due on ${startOfTarget.toISOString()}`);

    for (const loan of loans) {
      try {
        // Prevent duplicates for the same loan and due date
        // In this architecture, payload is JSON, we can query it or we can just fetch and check
        // Or better yet, we can check if a notification exists for this member, template, and Date
        
        const existingLog = await this.prisma.notificationLog.findFirst({
          where: {
            tenantId: loan.tenantId,
            memberId: loan.memberId,
            templateId: 'REPAYMENT_REMINDER',
            channel: 'IN_APP',
            createdAt: {
              gte: startOfDay(new Date()),
            },
          },
        });

        if (existingLog) {
          this.logger.debug(`Reminder already sent for loan ${loan.id} today. Skipping.`);
          continue;
        }

        const payload = {
          firstName: loan.member.user.firstName,
          loanNumber: loan.loanNumber,
          amount: loan.monthlyInstalment.toNumber(),
          dueDate: loan.dueDate?.toISOString().split('T')[0] ?? '',
          loanId: loan.id,
        };

        await this.notifications.send({
          tenantId: loan.tenantId,
          memberId: loan.memberId,
          channel: 'IN_APP',
          recipient: loan.memberId, // Using memberId as recipient for IN_APP
          templateId: 'REPAYMENT_REMINDER',
          payload,
        });

        this.logger.log(`Scheduled IN_APP repayment reminder for loan ${loan.id}`);
      } catch (err) {
        this.logger.error(`Failed to process reminder for loan ${loan.id}`, err);
      }
    }

    this.logger.log('Completed daily repayment reminder check.');
  }
}
