import { ApiProperty } from '@nestjs/swagger';

/** Response body for POST /mpesa/admin/dlq/:jobId/requeue */
export class DlqRequeueResponseDto {
  @ApiProperty({ description: 'Whether the job was successfully re-enqueued' })
  requeued!: boolean;

  @ApiProperty({ description: 'New BullMQ job ID assigned to the replayed job' })
  jobId!: string;
}
