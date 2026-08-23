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

/**
 * What a browser needs in order to complete this adapter's challenge.
 *
 * A real widget needs a provider script, a mount point, and matching
 * Content-Security-Policy origins — all provider facts. Naming Cloudflare in the
 * shared form view would put a provider inside `web` and defeat KTD2, so the
 * adapter publishes this descriptor instead and `web` renders it blind. A second
 * provider substitutes by returning a different descriptor; no view changes.
 *
 * Attribute values are rendered into HTML by the consumer and are escaped there.
 * Never put a secret here: everything in this object reaches the page.
 */
export interface AntibotClientChallenge {
  /** Script the page must load, or null for a challenge that needs none. */
  readonly scriptUrl: string | null;
  /** Element the provider script mounts into. */
  readonly mountTag: string;
  readonly mountAttributes: Readonly<Record<string, string>>;
  /** Form field the completed challenge writes its response into. */
  readonly responseFieldName: string;
  /** Human-facing label for the challenge block. */
  readonly label: string;
  /** Extra CSP sources this challenge requires, by directive. */
  readonly contentSecurityPolicy: {
    readonly scriptSrc: readonly string[];
    readonly frameSrc: readonly string[];
    readonly connectSrc: readonly string[];
  };
}

export interface AntibotPort {
  readonly name: string;
  readonly configured: boolean;
  /**
   * Null when the adapter needs nothing from the browser — the unconfigured
   * default, whose honeypot and per-IP cap are entirely server-side.
   */
  readonly clientChallenge: AntibotClientChallenge | null;
  verify(request: AntibotRequest): Promise<AntibotResult>;
}
