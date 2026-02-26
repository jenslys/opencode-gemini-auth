import { isRecord } from "./shared";

type JsonRecord = Record<string, unknown>;

const ANY_OF_DEFINITION_KEYS = new Set(["$defs", "defs", "definitions"]);

export function normalizeVertexFunctionDeclarationSchemas(requestPayload: JsonRecord): string[] {
  const tools = requestPayload.tools;
  if (!Array.isArray(tools)) {
    return [];
  }

  const issues: string[] = [];
  for (let toolIndex = 0; toolIndex < tools.length; toolIndex += 1) {
    const tool = tools[toolIndex];
    if (!isRecord(tool)) {
      continue;
    }

    const functionDeclarations = readFunctionDeclarations(tool);
    for (let declarationIndex = 0; declarationIndex < functionDeclarations.length; declarationIndex += 1) {
      const declaration = functionDeclarations[declarationIndex];
      if (!isRecord(declaration)) {
        continue;
      }

      const declarationName =
        (typeof declaration.name === "string" && declaration.name.trim().length > 0
          ? declaration.name.trim()
          : `tool_${toolIndex}_declaration_${declarationIndex}`);

      for (const schemaKey of ["parameters", "parametersJsonSchema", "parameters_json_schema"] as const) {
        const schema = declaration[schemaKey];
        if (!schema) {
          continue;
        }

        const normalizedSchema = normalizeSchemaAnyOfNodes(schema);
        declaration[schemaKey] = normalizedSchema;
        const violations = collectAnyOfSiblingViolations(normalizedSchema, schemaKey);
        for (const violation of violations) {
          issues.push(`${declarationName}:${violation}`);
        }
      }
    }
  }

  return issues;
}

export function collectAnyOfSiblingViolations(schema: unknown, startPath = "schema"): string[] {
  const issues: string[] = [];
  collectAnyOfSiblingViolationsInternal(schema, startPath, issues);
  return issues;
}

function collectAnyOfSiblingViolationsInternal(
  node: unknown,
  path: string,
  issues: string[],
): void {
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      collectAnyOfSiblingViolationsInternal(node[index], `${path}[${index}]`, issues);
    }
    return;
  }

  if (!isRecord(node)) {
    return;
  }

  const hasAnyOf = Array.isArray(node.anyOf) || Array.isArray(node.any_of);
  if (hasAnyOf) {
    const siblingKeys = Object.keys(node).filter(
      (key) => key !== "anyOf" && key !== "any_of" && !ANY_OF_DEFINITION_KEYS.has(key),
    );
    if (siblingKeys.length > 0) {
      issues.push(`${path} (extra keys: ${siblingKeys.join(",")})`);
    }
  }

  for (const [key, value] of Object.entries(node)) {
    collectAnyOfSiblingViolationsInternal(value, `${path}.${key}`, issues);
  }
}

function readFunctionDeclarations(tool: JsonRecord): unknown[] {
  if (Array.isArray(tool.functionDeclarations)) {
    return tool.functionDeclarations;
  }
  if (Array.isArray(tool.function_declarations)) {
    return tool.function_declarations;
  }
  return [];
}

function normalizeSchemaAnyOfNodes(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => normalizeSchemaAnyOfNodes(item));
  }

  if (!isRecord(schema)) {
    return schema;
  }

  const anyOf = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.any_of)
      ? schema.any_of
      : undefined;

  if (anyOf) {
    const normalizedAnyOf = anyOf.map((branch) => normalizeSchemaAnyOfNodes(branch));
    const preservedDefinitions = readAnyOfDefinitionSiblings(schema);
    if (Array.isArray(schema.any_of) && !Array.isArray(schema.anyOf)) {
      return {
        any_of: normalizedAnyOf,
        ...preservedDefinitions,
      };
    }
    return {
      anyOf: normalizedAnyOf,
      ...preservedDefinitions,
    };
  }

  const normalized: JsonRecord = {};
  for (const [key, value] of Object.entries(schema)) {
    normalized[key] = normalizeSchemaAnyOfNodes(value);
  }
  return normalized;
}

function readAnyOfDefinitionSiblings(schema: JsonRecord): JsonRecord {
  const preserved: JsonRecord = {};
  for (const key of ANY_OF_DEFINITION_KEYS) {
    if (!(key in schema)) {
      continue;
    }
    preserved[key] = normalizeSchemaAnyOfNodes(schema[key]);
  }
  return preserved;
}
