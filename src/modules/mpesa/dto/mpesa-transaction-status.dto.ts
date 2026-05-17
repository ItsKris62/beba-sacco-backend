import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TransactionStatus } from '@prisma/client';

export class MpesaTransactionStatusDto {
  @ApiProperty({ example: 'ws_CO_17052026123456789' })
  checkoutRequestId!: string;

  @ApiProperty({ enum: TransactionStatus, example: TransactionStatus.PENDING })
  status!: TransactionStatus;

  @ApiProperty({ example: '1000.0000' })
  amount!: string;

  @ApiProperty({ example: '2026-05-17T10:30:00.000Z' })
  lastUpdated!: Date;

  @ApiPropertyOptional({ example: 'STK_TIMEOUT_SWEEP' })
  failureReason?: string;
}
