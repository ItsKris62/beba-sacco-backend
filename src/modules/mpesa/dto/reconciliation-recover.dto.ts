import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export enum ReconciliationRecoveryAction {
  MANUAL_B2C_PAYOUT = 'MANUAL_B2C_PAYOUT',
  REVERSE_AUTO_REFUND = 'REVERSE_AUTO_REFUND',
}

export class ReconciliationRecoverDto {
  @ApiProperty({
    enum: ReconciliationRecoveryAction,
    description:
      'MANUAL_B2C_PAYOUT: pay the member out via M-Pesa now (used when the withdrawal never ' +
      'reached them and investigation confirms it should). ' +
      'REVERSE_AUTO_REFUND: undo a system auto-refund that a late Safaricom success callback ' +
      'proved was a false positive — re-debits the FOSA account that was incorrectly credited back.',
    example: ReconciliationRecoveryAction.MANUAL_B2C_PAYOUT,
  })
  @IsEnum(ReconciliationRecoveryAction)
  action!: ReconciliationRecoveryAction;

  @ApiProperty({
    description: 'Investigation notes — mandatory compliance record for any manual money movement.',
    example: 'Confirmed with Safaricom support ref SR-88213: original B2C payout never settled.',
  })
  @IsNotEmpty()
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  notes!: string;
}
