export interface EmailMessage {
  readonly recipients: readonly string[];
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface EmailDeliveryResult {
  readonly status: "sent" | "skipped";
  readonly providerMessageId?: string;
  readonly reason?: string;
}

export interface EmailPort {
  readonly name: string;
  readonly configured: boolean;
  deliver(message: EmailMessage): Promise<EmailDeliveryResult>;
}
