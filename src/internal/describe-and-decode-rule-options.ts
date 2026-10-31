import { Result, Schema } from "effect";

export const ruleOptionsJsonSchema = (options: Schema.Top) => [
  Schema.toJsonSchemaDocument(options, { onExcessProperty: "error" }).schema,
];

export const decodeRuleOptions = <Options extends Schema.Codec<unknown, unknown>>(
  options: Options,
  ruleOptions: readonly unknown[],
) => {
  const [givenOptions] = ruleOptions;
  return givenOptions === undefined
    ? undefined
    : Schema.decodeResult(options)(givenOptions, { onExcessProperty: "error" }).pipe(
        Result.match({
          onFailure: (error) => {
            throw error;
          },
          onSuccess: (decoded) => decoded,
        }),
      );
};
