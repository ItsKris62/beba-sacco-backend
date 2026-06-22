import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SupportRealtimeGateway } from '../support/support-realtime.gateway';

@Injectable()
export class InAppNotificationService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => SupportRealtimeGateway))
    private readonly supportGateway: SupportRealtimeGateway,
  ) {}

  async createAndEmit(tenantId: string, userId: string, title: string, body: string, type: string) {
    const notification = await this.prisma.inAppNotification.create({
      data: { tenantId, userId, title, body, type, isRead: false },
    });
    this.supportGateway.emitToUser(tenantId, userId, 'new_notification', notification);
    return notification;
  }

  async createManyAndEmit(tenantId: string, userIds: string[], title: string, body: string, type: string) {
    const data = userIds.map(userId => ({ tenantId, userId, title, body, type, isRead: false }));
    await this.prisma.inAppNotification.createMany({ data });
    
    // Emit individually since each user room is isolated
    for (const userId of userIds) {
      this.supportGateway.emitToUser(tenantId, userId, 'new_notification', { title, body, type });
    }
  }

  async list(tenantId: string, userId: string) {
    return this.prisma.inAppNotification.findMany({
      where: { tenantId, userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async markRead(tenantId: string, userId: string, notificationId: string) {
    return this.prisma.inAppNotification.update({
      where: { id: notificationId, tenantId, userId },
      data: { isRead: true },
    });
  }

  async unreadCount(tenantId: string, userId: string) {
    return this.prisma.inAppNotification.count({
      where: { tenantId, userId, isRead: false },
    });
  }
}
