export const ApiErrorExamples = {
  badUploadRequest: {
    description: 'Invalid request parameters',
    schema: {
      example: {
        status: 400,
        title: 'Bad Request',
        detail: [
          'checksum must be a 64-character lowercase hex string',
          'mimeType must be one of: image/jpeg, image/png, image/webp, application/pdf',
        ],
        errorCode: 'BadRequestException',
        correlationId: 'req_abc123',
      },
    },
  },
  authenticationRequired: {
    description: 'Authentication required',
    schema: {
      example: {
        status: 401,
        title: 'Authentication Required',
        detail: 'Authentication failed',
        errorCode: 'UnauthorizedException',
        correlationId: 'req_abc123',
      },
    },
  },
  forbiddenTenant: {
    description: 'Tenant isolation or role policy denied the request',
    schema: {
      example: {
        status: 403,
        title: 'Forbidden',
        detail: 'Access denied: tenant mismatch',
        errorCode: 'ForbiddenException',
        correlationId: 'req_abc123',
      },
    },
  },
  notFound: {
    description: 'Requested resource was not found in the tenant scope',
    schema: {
      example: {
        status: 404,
        title: 'Resource Not Found',
        detail: 'Document not found or already confirmed',
        errorCode: 'NotFoundException',
        correlationId: 'req_abc123',
      },
    },
  },
  payloadTooLarge: {
    description: 'File exceeds size limit',
    schema: {
      example: {
        status: 413,
        title: 'Payload Too Large',
        detail: 'File size 6291456 bytes exceeds maximum 5242880 bytes',
        errorCode: 'PayloadTooLargeException',
        maxBytes: 5242880,
        receivedBytes: 6291456,
        correlationId: 'req_abc123',
      },
    },
  },
  rateLimited: {
    description: 'Rate limit exceeded',
    schema: {
      example: {
        status: 429,
        title: 'Too Many Requests',
        detail: 'Too many upload requests. Try again in 60 seconds.',
        errorCode: 'ThrottlerException',
        retryAfter: 60,
        correlationId: 'req_abc123',
      },
    },
  },
  uploadTokenConflict: {
    description: 'Upload token invalid, expired, or already used',
    schema: {
      example: {
        status: 409,
        title: 'Conflict',
        detail: 'INVALID_UPLOAD_TOKEN',
        errorCode: 'ConflictException',
        reason: 'Token was already used for confirmation',
        correlationId: 'req_abc123',
      },
    },
  },
  checksumFailed: {
    description: 'Checksum verification failed or uploaded object is invalid',
    schema: {
      example: {
        status: 400,
        title: 'Bad Request',
        detail: 'FILE_INTEGRITY_CHECK_FAILED',
        errorCode: 'BadRequestException',
        details: 'Server-computed checksum does not match provided value',
        correlationId: 'req_abc123',
      },
    },
  },
  internalServerError: {
    description: 'Internal server error',
    schema: {
      example: {
        status: 500,
        title: 'Service Error',
        detail: 'Internal server error',
        errorCode: 'InternalServerError',
        correlationId: 'req_abc123',
        timestamp: '2026-05-21T10:30:00.000Z',
      },
    },
  },
} as const;
