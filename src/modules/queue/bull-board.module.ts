import { Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import type { Express, Request, Response, NextFunction } from 'express';

import { QUEUE_NAMES } from './queue.constants';

// ── Basic-auth middleware ─────────────────────────────────────────────────────
// Constant-time string comparison prevents timing attacks on the credential check.

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function basicAuth(user: string, pass: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const auth = req.headers['authorization'] as string | undefined;

    if (auth?.startsWith('Basic ')) {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (
        colon > 0 &&
        safeEqual(decoded.slice(0, colon), user) &&
        safeEqual(decoded.slice(colon + 1), pass)
      ) {
        next();
        return;
      }
    }

    res.setHeader('WWW-Authenticate', 'Basic realm="Bull Board"');
    res.status(401).send('Unauthorized');
  };
}

// ── Board service ─────────────────────────────────────────────────────────────
// Mounts the Bull Board Express router onto the running NestJS HTTP adapter
// after all modules are initialized (OnModuleInit fires before app.listen()).

@Injectable()
class BullBoardService implements OnModuleInit {
  private readonly logger = new Logger(BullBoardService.name);

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    @InjectQueue(QUEUE_NAMES.KYC_REVIEW)
    private readonly kycReviewQueue: Queue,
    @InjectQueue(QUEUE_NAMES.KYC_REVIEW_DLQ)
    private readonly kycReviewDlq: Queue,
    @InjectQueue(QUEUE_NAMES.EMAIL)
    private readonly emailQueue: Queue,
    @InjectQueue(QUEUE_NAMES.AUDIT_LOG)
    private readonly auditLogQueue: Queue,
    @InjectQueue(QUEUE_NAMES.MPESA_CALLBACK)
    private readonly mpesaCallbackQueue: Queue,
    @InjectQueue(QUEUE_NAMES.MPESA_CALLBACK_DLQ)
    private readonly mpesaCallbackDlq: Queue,
    @InjectQueue(QUEUE_NAMES.MPESA_DISBURSEMENT)
    private readonly mpesaDisbursementQueue: Queue,
    @InjectQueue(QUEUE_NAMES.MPESA_DISBURSEMENT_DLQ)
    private readonly mpesaDisbursementDlq: Queue,
    @InjectQueue(QUEUE_NAMES.DOCUMENT_CLEANUP)
    private readonly docCleanupQueue: Queue,
    @InjectQueue(QUEUE_NAMES.LOAN_DISBURSE)
    private readonly loanDisburseQueue: Queue,
  ) {}

  onModuleInit(): void {
    const boardUser = process.env.BULL_BOARD_USER ?? '';
    const boardPass = process.env.BULL_BOARD_PASS ?? '';

    if (!boardUser || !boardPass) {
      this.logger.warn(
        'BULL_BOARD_USER / BULL_BOARD_PASS not set — Bull Board will be inaccessible',
      );
      return;
    }

    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath('/admin/queues');

    createBullBoard({
      queues: [
        new BullMQAdapter(this.kycReviewQueue),
        new BullMQAdapter(this.kycReviewDlq),
        new BullMQAdapter(this.emailQueue),
        new BullMQAdapter(this.auditLogQueue),
        new BullMQAdapter(this.mpesaCallbackQueue),
        new BullMQAdapter(this.mpesaCallbackDlq),
        new BullMQAdapter(this.mpesaDisbursementQueue),
        new BullMQAdapter(this.mpesaDisbursementDlq),
        new BullMQAdapter(this.docCleanupQueue),
        new BullMQAdapter(this.loanDisburseQueue),
      ],
      serverAdapter,
    });

    const app = this.httpAdapterHost.httpAdapter.getInstance() as Express;
    app.use('/admin/queues', basicAuth(boardUser, boardPass), serverAdapter.getRouter());

    this.logger.log('Bull Board mounted at /admin/queues');
  }
}

// ── Module ────────────────────────────────────────────────────────────────────
// Registers its own BullModule.registerQueue() calls so it can inject the Queue
// instances it needs. These connect to the same underlying Redis queues as
// QueueModule — BullMQ queue instances are lightweight and share-safe.

@Module({
  imports: [
    BullModule.registerQueue(
      { name: QUEUE_NAMES.KYC_REVIEW },
      { name: QUEUE_NAMES.KYC_REVIEW_DLQ },
      { name: QUEUE_NAMES.EMAIL },
      { name: QUEUE_NAMES.AUDIT_LOG },
      { name: QUEUE_NAMES.MPESA_CALLBACK },
      { name: QUEUE_NAMES.MPESA_CALLBACK_DLQ },
      { name: QUEUE_NAMES.MPESA_DISBURSEMENT },
      { name: QUEUE_NAMES.MPESA_DISBURSEMENT_DLQ },
      { name: QUEUE_NAMES.DOCUMENT_CLEANUP },
      { name: QUEUE_NAMES.LOAN_DISBURSE },
    ),
  ],
  providers: [BullBoardService],
})
export class BullBoardModule {}
