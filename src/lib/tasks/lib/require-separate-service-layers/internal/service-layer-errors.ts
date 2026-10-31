import { Schema } from "effect";

import { listedViolations } from "../../../../../shared/format-reported-failures.ts";

export class ServiceLayerNotSeparate extends Schema.TaggedError<ServiceLayerNotSeparate>()(
  "ServiceLayerNotSeparate",
  { location: Schema.String, service: Schema.String },
) {
  public override get message() {
    return `${this.service}'s layer is inside the service class`;
  }
}

export class ServiceLayersRefused extends Schema.TaggedError<ServiceLayersRefused>()(
  "ServiceLayersRefused",
  { violations: Schema.Array(ServiceLayerNotSeparate) },
) {
  public override get message() {
    return listedViolations(this.violations);
  }
}
