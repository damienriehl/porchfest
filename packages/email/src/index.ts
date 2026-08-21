export type {
  EmailDeliveryResult,
  EmailMessage,
  EmailPort,
} from '@porchfest/core';

import type { EmailMessage, EmailPort } from '@porchfest/core';

export class NullEmailAdapter implements EmailPort {
  readonly name = 'none';
  readonly configured = false;

  async deliver(_message: EmailMessage) {
    return {
      status: 'skipped' as const,
      reason: 'No email provider is configured; use copy-paste delivery.',
    };
  }
}
