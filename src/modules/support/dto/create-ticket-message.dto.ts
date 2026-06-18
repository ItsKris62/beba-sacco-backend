import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, IsUrl, MinLength } from 'class-validator';

export class CreateTicketMessageDto {
  @ApiProperty({ example: 'Thanks, I have attached the receipt.' })
  @IsString()
  @MinLength(1)
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
}
