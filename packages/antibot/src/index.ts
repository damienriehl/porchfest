export type {
  AntibotPort,
  AntibotRequest,
  AntibotResult,
} from "@porchfest/core";

import type { AntibotPort, AntibotRequest } from "@porchfest/core";

export class NullAntibotAdapter implements AntibotPort {
  readonly name = "none";
  readonly configured = false;

  async verify(_request: AntibotRequest) {
    return {
      status: "not-configured" as const,
      reason: "No external challenge provider is configured.",
    };
  }
}
