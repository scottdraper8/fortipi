import type { AnySchema, ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { schemaRefs, schemaRegistry } from "fortipi-contract";
import { check } from "./errors.js";

const ajv = new Ajv2020({ strict: true, allErrors: false, validateFormats: false });
for (const schema of Object.values(schemaRegistry)) ajv.addSchema(schema as AnySchema);
const validators = new Map<string, ValidateFunction>();
export function validate(name: string, value: unknown): void {
  let validator = validators.get(name);
  if (!validator) {
    const ref = schemaRefs[name as keyof typeof schemaRefs];
    check(ref, "unknown_contract_schema");
    validator = ajv.compile({ $ref: ref });
    validators.set(name, validator);
  }
  check(validator(value), "invalid_contract_input");
}
