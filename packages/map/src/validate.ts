import {
  Ajv2020,
  type AnySchema,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import {
  VENUES_MAP_MINIMUM_SCHEMA_VERSION,
  isSupportedVenuesMapVersion,
  loadVerifiedVenuesMapSchema,
  type VenuesMapDocument,
} from "./contract.js";

export type VenuesMapValidationError = {
  path: string;
  message: string;
};

export type VenuesMapValidationResult =
  | { ok: true; document: VenuesMapDocument }
  | { ok: false; errors: ReadonlyArray<VenuesMapValidationError> };

let venuesMapValidator: ValidateFunction | undefined;

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

function getVenuesMapValidator(): ValidateFunction {
  if (venuesMapValidator !== undefined) return venuesMapValidator;

  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  const validator = ajv.compile(
    loadVerifiedVenuesMapSchema().schema as AnySchema,
  );
  venuesMapValidator = validator;
  return validator;
}

function escapeJsonPointerSegment(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function errorPath(error: ErrorObject): string {
  let path = error.instancePath;
  let property: unknown;

  if (error.keyword === "required") {
    property = error.params.missingProperty;
  } else if (error.keyword === "additionalProperties") {
    property = error.params.additionalProperty;
  }

  if (typeof property === "string") {
    path += `/${escapeJsonPointerSegment(property)}`;
  }

  return path || "/";
}

export function validateVenuesMapDocument(
  value: unknown,
): VenuesMapValidationResult {
  const validate = getVenuesMapValidator();
  if (!validate(value)) {
    return {
      ok: false,
      errors: (validate.errors ?? []).map((error) => ({
        path: errorPath(error),
        message: error.message ?? "is invalid",
      })),
    };
  }

  const document = value as VenuesMapDocument;
  if (!isSupportedVenuesMapVersion(document.schema_version)) {
    return {
      ok: false,
      errors: [
        {
          path: "/schema_version",
          message: `must be at least ${VENUES_MAP_MINIMUM_SCHEMA_VERSION} within the v1 schema family`,
        },
      ],
    };
  }

  return { ok: true, document };
}
