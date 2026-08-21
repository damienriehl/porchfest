export interface AntibotRequest {
  readonly token: string | null;
  readonly ipAddress: string;
}

export interface AntibotResult {
  readonly status: 'passed' | 'failed' | 'not-configured';
  readonly reason?: string;
}

export interface AntibotPort {
  readonly name: string;
  readonly configured: boolean;
  verify(request: AntibotRequest): Promise<AntibotResult>;
}
