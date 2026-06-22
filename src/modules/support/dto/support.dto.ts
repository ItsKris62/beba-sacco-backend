import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsString } from 'class-validator';

export class CreateIncidentDto {
  @ApiProperty() @IsString() @IsNotEmpty() title!: string;
  @ApiProperty() @IsString() @IsNotEmpty() description!: string;
  @ApiProperty() @IsString() @IsNotEmpty() severity!: string;
}

export class LinkTicketsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  ticketIds!: string[];
}

export class RequestPresignDto {
  @ApiProperty() @IsString() @IsNotEmpty() filename!: string;
  @ApiProperty() @IsString() @IsNotEmpty() contentType!: string;
}

export class SendMessageDto {
  @ApiProperty() @IsString() @IsNotEmpty() content!: string;
  @ApiProperty() @IsString() @IsNotEmpty() messageType!: string;
}
