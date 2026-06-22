import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { InAppNotificationService } from '../notifications/in-app-notification.service';
import { CreateIncidentDto, LinkTicketsDto } from './dto/support.dto';

@Injectable()
export class IncidentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: InAppNotificationService,
  ) {}

  async createIncident(tenantId: string, dto: CreateIncidentDto) {
    return this.prisma.incident.create({
      data: {
        tenantId,
        title: dto.title,
        description: dto.description,
        severity: dto.severity,
        status: 'INVESTIGATING',
      },
    });
  }

  async updateIncident(tenantId: string, id: string, data: { status?: string; description?: string }) {
    return this.prisma.incident.update({
      where: { id, tenantId },
      data,
    });
  }

  async linkTickets(tenantId: string, id: string, dto: LinkTicketsDto) {
    const incident = await this.prisma.incident.findUniqueOrThrow({ where: { id, tenantId } });
    
    await this.prisma.supportTicket.updateMany({
      where: { id: { in: dto.ticketIds }, tenantId },
      data: { incidentId: incident.id },
    });
    return { linked: dto.ticketIds.length };
  }

  async notifyAffectedMembers(tenantId: string, id: string) {
    const tickets = await this.prisma.supportTicket.findMany({
      where: { incidentId: id, tenantId },
      include: { member: true },
    });
    
    const userIds = [...new Set(tickets.map(t => t.member?.userId).filter(Boolean))];
    if (userIds.length > 0) {
      await this.notifications.createManyAndEmit(
        tenantId,
        userIds,
        'Incident Update',
        'There is an update on an incident affecting your support ticket.',
        'INCIDENT_UPDATE'
      );
    }
    return { notifiedCount: userIds.length };
  }

  async listIncidents(tenantId: string, query?: any) {
    return this.prisma.incident.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      include: { tickets: true },
    });
  }
}
