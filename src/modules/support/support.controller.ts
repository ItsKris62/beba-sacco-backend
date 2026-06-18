import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { TicketStatus, UserRole } from '@prisma/client';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';
import { CreateSupportTicketDto } from './dto/create-support-ticket.dto';
import { CreateTicketMessageDto } from './dto/create-ticket-message.dto';
import { UpdateSupportTicketDto } from './dto/update-support-ticket.dto';
import { SupportService } from './support.service';

@ApiTags('Support')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@Controller('support/tickets')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Post()
  @Roles(UserRole.MEMBER)
  @ApiOperation({
    summary: 'Create a support ticket',
    description:
      'Creates a member-owned support ticket and stores the opening description as the first ticket message.',
  })
  @ApiResponse({
    status: 201,
    description: 'Ticket created',
    schema: {
      example: {
        id: '550e8400-e29b-41d4-a716-446655440000',
        subject: 'Question about loan processing fee',
        status: 'OPEN',
        priority: 'MEDIUM',
        category: 'LOAN_QUERY',
        relatedLoanId: '9b29f4b9-41a5-4ef6-8440-8e5d05f2ef51',
        messages: [
          {
            id: '0b00a026-2da5-4545-b9db-6e221da7747d',
            content: 'Please explain the processing fee on my disbursement.',
            senderRole: 'MEMBER',
            attachments: [],
          },
        ],
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  @ApiResponse({ status: 403, description: 'Only active members can create support tickets' })
  create(
    @Body() dto: CreateSupportTicketDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.support.createTicket(dto, tenant.id, actor);
  }

  @Get()
  @Roles(UserRole.MEMBER, UserRole.LOAN_OFFICER, UserRole.MANAGER, UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'List support tickets',
    description:
      'Members see only their own tickets. Staff roles see the tenant support queue, optionally filtered by status.',
  })
  @ApiQuery({ name: 'status', enum: TicketStatus, required: false })
  @ApiResponse({
    status: 200,
    description: 'Support ticket list',
    schema: {
      example: [
        {
          id: '550e8400-e29b-41d4-a716-446655440000',
          subject: 'Question about loan processing fee',
          status: 'OPEN',
          priority: 'MEDIUM',
          category: 'LOAN_QUERY',
          member: {
            id: 'd67f44a9-e017-4421-9db6-06fc97af6c3e',
            memberNumber: 'M-000001',
          },
          messages: [],
        },
      ],
    },
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token' })
  list(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Query('status') status?: TicketStatus,
  ) {
    return this.support.listTickets(tenant.id, actor, status);
  }

  @Get(':id')
  @Roles(UserRole.MEMBER, UserRole.LOAN_OFFICER, UserRole.MANAGER, UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get a support ticket with messages' })
  @ApiParam({ name: 'id', description: 'Ticket UUID' })
  @ApiResponse({
    status: 200,
    description: 'Support ticket with ordered message thread',
    schema: {
      example: {
        id: '550e8400-e29b-41d4-a716-446655440000',
        subject: 'Question about loan processing fee',
        status: 'OPEN',
        messages: [
          {
            id: '0b00a026-2da5-4545-b9db-6e221da7747d',
            content: 'Please explain the processing fee on my disbursement.',
            senderRole: 'MEMBER',
            createdAt: '2026-06-18T09:00:00.000Z',
          },
        ],
      },
    },
  })
  @ApiResponse({ status: 403, description: 'Members can only view their own support tickets' })
  @ApiResponse({ status: 404, description: 'Support ticket not found' })
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.support.getTicket(id, tenant.id, actor);
  }

  @Post(':id/messages')
  @Roles(UserRole.MEMBER, UserRole.LOAN_OFFICER, UserRole.MANAGER, UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Add a ticket message',
    description:
      'Appends a message to the ticket thread. Member replies reopen the ticket; staff replies mark it waiting on member.',
  })
  @ApiParam({ name: 'id', description: 'Ticket UUID' })
  @ApiResponse({
    status: 201,
    description: 'Message added to ticket thread',
    schema: {
      example: {
        id: '0b00a026-2da5-4545-b9db-6e221da7747d',
        ticketId: '550e8400-e29b-41d4-a716-446655440000',
        senderRole: 'MEMBER',
        content: 'Thanks, I have attached the receipt.',
        attachments: ['https://storage.example.com/support/receipt.png'],
      },
    },
  })
  @ApiResponse({ status: 403, description: 'Members can only reply to their own tickets' })
  @ApiResponse({ status: 404, description: 'Support ticket not found' })
  addMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateTicketMessageDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.support.addMessage(id, dto, tenant.id, actor);
  }

  @Patch(':id')
  @Roles(UserRole.LOAN_OFFICER, UserRole.MANAGER, UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Update ticket status, priority, assignment, or staff note',
    description:
      'Staff-only mutation for support queue triage. When note is supplied, it is appended as a ticket message.',
  })
  @ApiParam({ name: 'id', description: 'Ticket UUID' })
  @ApiResponse({
    status: 200,
    description: 'Ticket updated',
    schema: {
      example: {
        id: '550e8400-e29b-41d4-a716-446655440000',
        status: 'WAITING_ON_MEMBER',
        priority: 'HIGH',
        assignedTo: '1e9ebff1-f9f9-4f52-a2a6-1c117c71b4f2',
        messages: [],
      },
    },
  })
  @ApiResponse({ status: 403, description: 'Staff role required' })
  @ApiResponse({ status: 404, description: 'Support ticket not found' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSupportTicketDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.support.updateTicket(id, dto, tenant.id, actor);
  }
}
