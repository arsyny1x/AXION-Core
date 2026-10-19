/**
 * Core.custom — user/integrator registered functions with permission checks.
 *
 * Registration rules:
 *  - Names must be unique (per scope).
 *  - Handlers must be functions.
 *  - Names must not collide with reserved prefixes (`__`, `Core`).
 *  - Every registered function has a description, schema, and permission list.
 *
 * Invocation rules (for the future Lua binding):
 *  - The caller must hold every permission declared by the function.
 *  - Unknown functions must fail loudly.
 */

import { err } from "../errors";
import type {
  CustomFunctionInfo,
  CustomFunctionRegistration,
  FunctionSchema,
  ICustomApi,
  IPermissionChecker,
  PermissionName,
  ParamSchema,
} from "../types";
import { assertFunction, assertObject, assertString } from "../validation/validators";

export interface CustomApiOptions {
  permissions?: IPermissionChecker;
  now: () => number;
}

const RESERVED_PREFIXES = ["__", "Core."];

export interface CustomApi extends ICustomApi {
  /** Invoke a registered function after permission checks. */
  invoke(name: string, args: unknown[]): Promise<unknown>;
  /** Return the parsed registration records (used by the Lua binding layer). */
  entries(): ReadonlyArray<{ info: CustomFunctionInfo; handler: CustomFunctionRegistration["handler"] }>;
}

export function createCustomApi(options: CustomApiOptions): CustomApi {
  const registry = new Map<string, { info: CustomFunctionInfo; handler: CustomFunctionRegistration["handler"] }>();

  return {
    registerFunction(registration: CustomFunctionRegistration): void {
      const reg = validateRegistration(registration);
      if (registry.has(reg.name)) throw err.duplicateFunction(reg.name);
      if (RESERVED_PREFIXES.some((p) => reg.name.startsWith(p))) {
        throw err.invalidArgument(`Function name "${reg.name}" uses a reserved prefix`);
      }
      const info: CustomFunctionInfo = {
        name: reg.name,
        description: reg.description ?? "",
        schema: normalizeSchema(reg.schema),
        permissions: reg.permissions ?? [],
        registeredAt: options.now(),
      };
      registry.set(reg.name, { info, handler: reg.handler });
    },

    unregisterFunction(name: string): void {
      const n = assertString(name, "name");
      if (!registry.delete(n)) throw err.functionNotFound(n);
    },

    listFunctions(): CustomFunctionInfo[] {
      return [...registry.values()].map((entry) => ({ ...entry.info }));
    },

    getFunctionInfo(name: string): CustomFunctionInfo | null {
      const n = assertString(name, "name");
      const entry = registry.get(n);
      return entry ? { ...entry.info } : null;
    },

    async invoke(name: string, args: unknown[]): Promise<unknown> {
      const n = assertString(name, "name");
      const entry = registry.get(n);
      if (!entry) throw err.functionNotFound(n);
      if (!Array.isArray(args)) throw err.invalidArgument("args must be an array");
      const checker = options.permissions;
      for (const permission of entry.info.permissions) {
        if (!checker || !checker.has(permission)) {
          throw err.permissionDenied(`Missing permission "${permission}" for "${n}"`, {
            function: n,
            permission,
          });
        }
      }
      return await entry.handler(...args);
    },

    entries() {
      return [...registry.values()];
    },
  };
}

function validateRegistration(value: unknown): CustomFunctionRegistration {
  const obj = assertObject(value, "registration");
  const name = assertString(obj["name"], "name");
  const handler = assertFunction(obj["handler"], "handler") as CustomFunctionRegistration["handler"];
  const description =
    obj["description"] === undefined ? undefined : assertString(obj["description"], "description", { allowEmpty: true });
  const schema = obj["schema"] === undefined ? undefined : validateSchema(obj["schema"]);
  const permissions =
    obj["permissions"] === undefined ? undefined : validatePermissions(obj["permissions"]);
  const out: CustomFunctionRegistration = { name, handler };
  if (description !== undefined) out.description = description;
  if (schema !== undefined) out.schema = schema;
  if (permissions !== undefined) out.permissions = permissions;
  return out;
}

function validateSchema(value: unknown): FunctionSchema {
  const obj = assertObject(value, "schema");
  const params = obj["params"];
  let normalizedParams: Record<string, ParamSchema> | undefined;
  if (params !== undefined) {
    const paramObj = assertObject(params, "schema.params");
    normalizedParams = {};
    for (const [key, raw] of Object.entries(paramObj)) {
      normalizedParams[key] = validateParamSchema(raw, `schema.params.${key}`);
    }
  }
  const returns = obj["returns"] === undefined ? undefined : assertString(obj["returns"], "schema.returns");
  const description = obj["description"] === undefined ? undefined : assertString(obj["description"], "schema.description", { allowEmpty: true });
  const out: FunctionSchema = {};
  if (normalizedParams) out.params = normalizedParams;
  if (returns !== undefined) out.returns = returns;
  if (description !== undefined) out.description = description;
  return out;
}

const ALLOWED_PARAM_TYPES = ["string", "number", "boolean", "object", "array", "any", "null"] as const;

function validateParamSchema(value: unknown, label: string): ParamSchema {
  const obj = assertObject(value, label);
  const type = assertString(obj["type"], `${label}.type`);
  if (!(ALLOWED_PARAM_TYPES as readonly string[]).includes(type)) {
    throw err.invalidArgument(
      `${label}.type must be one of: ${ALLOWED_PARAM_TYPES.join(", ")}`,
      { received: type },
    );
  }
  const out: ParamSchema = { type: type as ParamSchema["type"] };
  if (obj["required"] !== undefined) {
    if (typeof obj["required"] !== "boolean") {
      throw err.invalidArgument(`${label}.required must be a boolean`);
    }
    out.required = obj["required"];
  }
  if (obj["description"] !== undefined) {
    out.description = assertString(obj["description"], `${label}.description`, { allowEmpty: true });
  }
  if (obj["min"] !== undefined) {
    if (typeof obj["min"] !== "number") throw err.invalidArgument(`${label}.min must be a number`);
    out.min = obj["min"];
  }
  if (obj["max"] !== undefined) {
    if (typeof obj["max"] !== "number") throw err.invalidArgument(`${label}.max must be a number`);
    out.max = obj["max"];
  }
  if (obj["enum"] !== undefined) {
    if (!Array.isArray(obj["enum"])) throw err.invalidArgument(`${label}.enum must be an array`);
    out.enum = obj["enum"];
  }
  return out;
}

function validatePermissions(value: unknown): PermissionName[] {
  if (!Array.isArray(value)) throw err.invalidArgument("permissions must be an array");
  return value.map((item, i) => assertString(item, `permissions[${i}]`));
}

function normalizeSchema(schema: FunctionSchema | undefined): FunctionSchema {
  return schema ? { ...schema } : {};
}