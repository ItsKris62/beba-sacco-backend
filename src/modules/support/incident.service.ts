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
    const incident = await this.prisma.incident.create({
      data: {
        tenantId,
        title: dto.title,
        description: dto.description,
        severity: dto.severity,
        status: 'INVESTIGATING',
      },
    });
    return this.withPresentationFields(incident);
  }

  async getIncident(tenantId: string, id: string) {
    const incident = await this.prisma.incident.findUnique({
      where: { id, tenantId },
      include: { tickets: true },
    });
    if (!incident) throw new NotFoundException('Incident not found');
    return this.withPresentationFields(incident);
  }

  async getIncidentTickets(tenantId: string, id: string) {
    await this.getIncident(tenantId, id);
    return this.prisma.supportTicket.findMany({
      where: { incidentId: id, tenantId },
      include: {
        member: {
          select: {
            id: true,
            memberNumber: true,
            user: { select: { firstName: true, lastName: true, email: true, phoneNumber: true } },
          },
        },
        messages: { orderBy: { createdAt: 'asc' } },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async updateIncident(tenantId: string, id: string, data: { status?: string; description?: string }) {
    const incident = await this.prisma.incident.update({
      where: { id, tenantId },
      data,
    });
    return this.withPresentationFields(incident);
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
    const incidents = await this.prisma.incident.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      include: { tickets: true },
    });
    return incidents.map((incident) => this.withPresentationFields(incident));
  }

  private withPresentationFields<T extends { description: string }>(incident: T): T & { affectedService: string } {
    return {
      ...incident,
      affectedService: 'Core Banking',
    };
  }
}
