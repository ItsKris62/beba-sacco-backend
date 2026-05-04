import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO for GET /admin/members/:id/guarantor-exposure
 * Shows a member's total guarantee exposure and active guarantees.
 */
export class GuarantorExposureResponseDto {
  @ApiProperty({ description: 'Member ID' })
  memberId!: string;

  @ApiProperty({ description: 'Member number' })
  memberNumber!: string;

  @ApiProperty({ description: 'Member full name' })
  memberName!: string;

  @ApiProperty({ description: 'Maximum concurrent guarantees allowed', example: 3 })
  maxConcurrentGuarantees!: number;

  @ApiProperty({ description: 'Current number of active guarantees', example: 2 })
  currentGuaranteeCount!: number;

  @ApiProperty({ description: 'Total amount currently guaranteed (KES)', example: 75000 })
  totalGuaranteedAmount!: number;

  @ApiProperty({ description: 'Remaining guarantee capacity (KES)', example: 25000 })
  remainingCapacity!: number;

  @ApiProperty({ description: 'Whether the member can guarantee another loan', example: true })
  canGuarantee!: boolean;

  @ApiProperty({
    description: 'List of active guarantees',
    type: 'array',
    items: {
      type: 'object',
      properties: {
        loanId: { type: 'string' },
        loanNumber: { type: 'string' },
        guaranteedAmount: { type: 'number' },
        borrowerName: { type: 'string' },
        status: { type: 'string' },
      },
    },
  })
  activeGuarantees!: Array<{
    loanId: string;
    loanNumber: string;
    guaranteedAmount: number;
    borrowerName: string;
    status: string;
  }>;
}
