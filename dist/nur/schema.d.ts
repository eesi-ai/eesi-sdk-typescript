export type SchemaType = "string" | "number" | "integer" | "boolean" | "null" | "array" | "object";
export interface JSONSchema {
    type?: SchemaType | readonly SchemaType[];
    description?: string;
    enum?: readonly unknown[];
    const?: unknown;
    properties?: {
        readonly [key: string]: JSONSchema;
    };
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
type Simplify<T> = {
    [K in keyof T]: T[K];
} & {};
type ObjectFrom<P, R> = Simplify<{
    -readonly [K in keyof P & R]: FromSchema<P[K]>;
} & {
    -readonly [K in Exclude<keyof P, R>]?: FromSchema<P[K]>;
}>;
/** The TypeScript type a JSON Schema describes. */
export type FromSchema<S> = S extends {
    const: infer C;
} ? C : S extends {
    enum: readonly (infer E)[];
} ? E : S extends {
    anyOf: readonly (infer A)[];
} ? FromSchema<A> : S extends {
    type: "string";
} ? string : S extends {
    type: "number" | "integer";
} ? number : S extends {
    type: "boolean";
} ? boolean : S extends {
    type: "null";
} ? null : S extends {
    type: "array";
    items: infer I;
} ? Array<FromSchema<I>> : S extends {
    type: "array";
} ? unknown[] : S extends {
    type: "object";
    properties: infer P;
} ? ObjectFrom<P, S extends {
    required: readonly (infer R)[];
} ? R : never> : S extends {
    type: "object";
} ? Record<string, unknown> : unknown;
/** Every way `value` breaks `schema`, as `path: problem` lines; empty when it fits. */
export declare function validateSchema(schema: JSONSchema, value: unknown, path?: string): string[];
export {};
//# sourceMappingURL=schema.d.ts.map