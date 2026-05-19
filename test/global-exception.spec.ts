import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { GlobalExceptionFilter } from './global-exception.filter';
import { PinoLogger } from 'nestjs-pino';

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;
  let loggerMock: jest.Mocked<PinoLogger>;

  beforeEach(() => {
    loggerMock = {
      setContext: jest.fn(),
      error: jest.fn(),
    } as any;
    filter = new GlobalExceptionFilter(loggerMock);
  });

  it('should map 422 to INSUFFICIENT_FUNDS envelope', () => {
    const mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const mockRequest = { headers: { 'x-correlation-id': 'trace-123', 'x-tenant-id': 'tenant-A' } };
    const hostMock = {
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
    } as ArgumentsHost;

    const exception = new HttpException('Balance too low', HttpStatus.UNPROCESSABLE_ENTITY);
    
    filter.catch(exception, hostMock);

    expect(mockResponse.status).toHaveBeenCalledWith(422);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'INSUFFICIENT_FUNDS',
          message: 'Balance too low',
          traceId: 'trace-123',
        })
      })
    );
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: 'trace-123', tenantId: 'tenant-A' }),
      'Exception caught by Global Filter'
    );
  });
});