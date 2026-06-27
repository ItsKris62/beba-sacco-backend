import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsOptional, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';

export class CreateTicketMessageDto {
  @ApiProperty({ example: 'Thanks, I have attached the receipt.' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  content!: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'R2/MinIO pre-signed URLs attached to the ticket message',
    example: ['https://storage.example.com/support/receipt.png'],
  })
  @IsOptional()
  @IsArray()
  @IsUrl({}, { each: true })
  attachments?: string[];

  @ApiPropertyOptional({ description: 'Reopen a closed ticket while posting this message', example: true })
  @IsOptional()
  @IsBoolean()
  reopen?: boolean;
}


