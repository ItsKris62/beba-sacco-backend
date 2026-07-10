import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class MemberIdentityDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  memberNumber!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty()
  kycStatus!: string;

  @ApiPropertyOptional({ nullable: true })
  kycRejectionReason?: string | null;

  @ApiPropertyOptional({ nullable: true })
  profileImageKey?: string | null;

  @ApiProperty()
  updatedAt!: string;
}

export class MemberDashboardBalancesDto {
  @ApiProperty()
  fosa!: number;

  @ApiProperty()
  bosa!: number;

  @ApiPropertyOptional({ nullable: true })
  fosaAccountId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  bosaAccountId!: string | null;
}

export class MemberDashboardLoanDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  loanNumber!: string;

  @ApiProperty()
  principalAmount!: number;

  @ApiProperty()
  outstandingBalance!: number;

  @ApiProperty()
  monthlyInstalment!: number;

  @ApiPropertyOptional({ nullable: true })
  dueDate!: string | null;
}

export class MemberDashboardTransactionDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  type!: string;

  @ApiProperty()
  amount!: number;

  @ApiProperty()
  balanceAfter!: number;

  @ApiPropertyOptional({ nullable: true })
  description!: string | null;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty({ type: () => Object })
  account!: { accountType: string };
}

export class MemberDashboardGuarantorRequestDto {
  @ApiProperty()
  guarantorId!: string;

  @ApiProperty()
  loanId!: string;

  @ApiProperty()
  loanNumber!: string;

  @ApiProperty()
  applicantName!: string;

  @ApiProperty()
  loanAmount!: number;

  @ApiProperty()
  guaranteedAmount!: number;

  @ApiPropertyOptional({ nullable: true })
  purpose!: string | null;

  @ApiProperty()
  invitedAt!: string;
}

export class MemberDashboardDto {
  @ApiProperty({ type: () => MemberIdentityDto })
  member!: MemberIdentityDto;

  @ApiProperty({ type: () => MemberDashboardBalancesDto })
  balances!: MemberDashboardBalancesDto;

  @ApiProperty({ type: () => [MemberDashboardLoanDto] })
  activeLoans!: MemberDashboardLoanDto[];

  @ApiProperty({ type: () => [MemberDashboardTransactionDto] })
  recentTransactions!: MemberDashboardTransactionDto[];

  @ApiProperty({ type: () => [MemberDashboardGuarantorRequestDto] })
  pendingGuarantorRequests!: MemberDashboardGuarantorRequestDto[];

  @ApiProperty()
  loadedAt!: string;

  @ApiPropertyOptional({ type: () => [String] })
  warnings?: string[];
}
