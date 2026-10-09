// JSON Schema for tool arguments: the types it implies, and a validator.
//
// A tool describes its arguments as JSON Schema, which is what the model
// reads. `FromSchema` turns that same schema into the TypeScript type of the
// arguments your function receives, so one declaration serves both, and
// `validateSchema` checks what the model sent before your function runs.
// Covered: type, enum, const, properties, required, additionalProperties,
// items, anyOf, and the numeric, string and array bounds.

export type SchemaType = "string" | "number" | "integer" | "boolean" | "null" | "array" | "object";

export interface JSONSchema {
    type?: SchemaType | readonly SchemaType[];
    description?: string;
    enum?: readonly unknown[];
    const?: unknown;
    properties?: { readonly [key: string]: JSONSchema };
    required?: readonly string[];
    additionalProperties?: boolean | JSONSchema;
    items?: JSONSchema;
    anyOf?: readonly JSONSchema[];
    minimum?: number;
    maximum?: number;
    minLength?: number;
    maxLength?: number;
    minItems?: number;
    maxItems?: number;
    default?: unknown;
    [keyword: string]: unknown;
}

/** The schema of a tool's arguments: always an object. */
export interface ObjectSchema extends JSONSchema {
    type: "object";
}

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type ObjectFrom<P, R> = Simplify<
    { -readonly [K in keyof P & R]: FromSchema<P[K]> } & { -readonly [K in Exclude<keyof P, R>]?: FromSchema<P[K]> }
>;

/** The TypeScript type a JSON Schema describes. */
export type FromSchema<S> = S extends { const: infer C }
    ? C
    : S extends { enum: readonly (infer E)[] }
      ? E
      : S extends { anyOf: readonly (infer A)[] }
        ? FromSchema<A>
        : S extends { type: "string" }
          ? string
          : S extends { type: "number" | "integer" }
            ? number
            : S extends { type: "boolean" }
              ? boolean
              : S extends { type: "null" }
                ? null
                : S extends { type: "array"; items: infer I }
                  ? Array<FromSchema<I>>
                  : S extends { type: "array" }
                    ? unknown[]
                    : S extends { type: "object"; properties: infer P }
                      ? ObjectFrom<P, S extends { required: readonly (infer R)[] } ? R : never>
                      : S extends { type: "object" }
                        ? Record<string, unknown>
                        : unknown;

function typeOf(value: unknown): SchemaType {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
    return typeof value as SchemaType;
}

function accepts(expected: SchemaType, actual: SchemaType): boolean {
    return expected === actual || (expected === "number" && actual === "integer");
}

/** Every way `value` breaks `schema`, as `path: problem` lines; empty when it fits. */
export function validateSchema(schema: JSONSchema, value: unknown, path = ""): string[] {
    const at = path || "arguments";
    if (schema.anyOf) {
        return schema.anyOf.some((option) => validateSchema(option, value, path).length === 0)
            ? []
            : [`${at}: matches none of the allowed shapes`];
    }
    if ("const" in schema && schema.const !== undefined && value !== schema.const) {
        return [`${at}: must be ${JSON.stringify(schema.const)}`];
    }
    if (schema.enum && !schema.enum.includes(value)) {
        return [`${at}: must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`];
    }
    if (schema.type) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type as SchemaType];
        const actual = typeOf(value);
        if (!types.some((expected) => accepts(expected, actual))) {
            return [`${at}: must be ${types.join(" or ")}, not ${actual}`];
        }
    }
    const problems: string[] = [];
    if (typeof value === "number") {
        if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${at}: must be at least ${schema.minimum}`);
        if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${at}: must be at most ${schema.maximum}`);
    }
    if (typeof value === "string") {
        if (schema.minLength !== undefined && value.length < schema.minLength) problems.push(`${at}: must be at least ${schema.minLength} characters`);
        if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(`${at}: must be at most ${schema.maxLength} characters`);
    }
    if (Array.isArray(value)) {
        if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(`${at}: needs at least ${schema.minItems} items`);
        if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${at}: allows at most ${schema.maxItems} items`);
        if (schema.items) value.forEach((item, index) => problems.push(...validateSchema(schema.items as JSONSchema, item, `${path}[${index}]`)));
    }
    if (typeOf(value) === "object" && value !== null) {
        const object = value as Record<string, unknown>;
        for (const key of schema.required ?? []) {
            if (!(key in object)) problems.push(`${path ? `${path}.` : ""}${key}: is required`);
        }
        const properties = schema.properties ?? {};
        for (const [key, item] of Object.entries(object)) {
            const child = properties[key];
            const where = path ? `${path}.${key}` : key;
            if (child) problems.push(...validateSchema(child, item, where));
            else if (schema.additionalProperties === false) problems.push(`${where}: is not an argument this tool takes`);
            else if (typeof schema.additionalProperties === "object") problems.push(...validateSchema(schema.additionalProperties, item, where));
        }
    }
    return problems;
}
