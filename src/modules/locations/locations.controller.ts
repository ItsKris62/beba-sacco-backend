import { Controller, Get, Query, BadRequestException } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiSecurity,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiHeader,
} from '@nestjs/swagger';
import { LocationsService } from './locations.service';

/**
 * LocationsController
 *
 * Serves the scoped location hierarchy for Nairobi + Western Kenya.
 * All endpoints are Redis-cached (24 h TTL) and require authentication.
 *
 * Cascade pattern: County → Constituency → Ward
 * Frontend uses cascading dropdowns driven by these endpoints.
 */
@ApiTags('Locations')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@Controller('locations')
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  // ─── Counties ────────────────────────────────────────────────────────────────

  @Get('counties')
  @ApiOperation({
    summary: 'List all scoped counties',
    description:
      'Returns Nairobi + 11 Western Kenya counties. Results are Redis-cached for 24 h.',
  })
  @ApiResponse({ status: 200, description: 'List of counties' })
  getCounties() {
    return this.locationsService.getCounties();
  }

  // ─── Constituencies ───────────────────────────────────────────────────────────

  @Get('constituencies')
  @ApiOperation({
    summary: 'List constituencies for a county',
    description: 'Returns constituencies scoped to the given countyId. Redis-cached 24 h.',
  })
  @ApiQuery({ name: 'countyId', required: true, type: String, description: 'County cuid' })
  @ApiResponse({ status: 200, description: 'List of constituencies' })
  @ApiResponse({ status: 400, description: 'countyId is required' })
  getConstituencies(@Query('countyId') countyId: string) {
    if (!countyId?.trim()) {
      throw new BadRequestException('countyId query parameter is required');
    }
    return this.locationsService.getConstituencies(countyId);
  }

  // ─── Wards ────────────────────────────────────────────────────────────────────

  @Get('wards')
  @ApiOperation({
    summary: 'List wards for a constituency',
    description: 'Returns wards scoped to the given constituencyId. Redis-cached 24 h.',
  })
  @ApiQuery({
    name: 'constituencyId',
    required: true,
    type: String,
    description: 'Constituency cuid',
  })
  @ApiResponse({ status: 200, description: 'List of wards' })
  @ApiResponse({ status: 400, description: 'constituencyId is required' })
  getWards(@Query('constituencyId') constituencyId: string) {
    if (!constituencyId?.trim()) {
      throw new BadRequestException('constituencyId query parameter is required');
    }
    return this.locationsService.getWards(constituencyId);
  }
}
