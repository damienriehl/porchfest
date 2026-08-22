export interface AntibotRequest {
  readonly token: string | null;
  readonly ipAddress: string;
}

export type AntibotResult =
  | {
      readonly status: "passed";
      readonly reason?: never;
    }
  | {
      readonly status: "failed" | "not-configured" | "unavailable";
      readonly reason: string;
    };

export interface AntibotPort {
  readonly name: string;
  readonly configured: boolean;
  verify(request: AntibotRequest): Promise<AntibotResult>;
}
