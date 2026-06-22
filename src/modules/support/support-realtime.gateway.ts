import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { SupportService } from './support.service';
import { AuthActor } from './support-ticket.types';

@WebSocketGateway({ namespace: 'support_chat', cors: { origin: '*' } })
export class SupportRealtimeGateway implements OnGatewayConnection {
  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly supportService: SupportService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth.token || client.handshake.headers.authorization?.split(' ')[1];
      const tenantId = client.handshake.headers['x-tenant-id'] as string;

      if (!token || !tenantId) throw new Error('Unauthorized');

      const payload = this.jwtService.verify(token);
      client.data.actor = { userId: payload.sub, role: payload.role } as AuthActor;
      client.data.tenantId = tenantId;

      // Join tenant-scoped user room for notifications
      client.join(`${tenantId}:user:${payload.sub}`);
    } catch {
      client.disconnect();
    }
  }

  @SubscribeMessage('join_ticket_room')
  async joinTicketRoom(
    @MessageBody() data: { ticketId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { ticketId } = data;
    const { tenantId, actor } = client.data;

    await this.supportService.assertTicketAccess(ticketId, tenantId, actor);
    client.join(`${tenantId}:ticket:${ticketId}`);
  }

  @SubscribeMessage('send_message')
  async sendMessage(
    @MessageBody() data: { ticketId: string; content: string; messageType: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { tenantId, actor } = client.data;
    
    // Save to DB and assert access simultaneously
    const message = await this.supportService.addMessage(data.ticketId, { content: data.content }, tenantId, actor);
    
    this.server.to(`${tenantId}:ticket:${data.ticketId}`).emit('new_message', message);
  }

  @SubscribeMessage('typing_indicator')
  async typingIndicator(
    @MessageBody() data: { ticketId: string; isTyping: boolean },
    @ConnectedSocket() client: Socket,
  ) {
    const { tenantId, actor } = client.data;
    this.server.to(`${tenantId}:ticket:${data.ticketId}`).emit('typing_indicator', {
      ticketId: data.ticketId,
      userId: actor.userId,
      isTyping: data.isTyping,
    });
  }

  @SubscribeMessage('message_read')
  async messageRead(
    @MessageBody() data: { ticketId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { tenantId, actor } = client.data;
    await this.supportService.markMessagesRead(data.ticketId, tenantId, actor);
  }

  emitToUser(tenantId: string, userId: string, event: string, payload: any) {
    this.server.to(`${tenantId}:user:${userId}`).emit(event, payload);
  }
}
