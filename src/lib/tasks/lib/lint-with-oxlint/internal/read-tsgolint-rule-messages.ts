import { Array as Arrays, Option, Result, Schema } from "effect";

const HEADER_BYTES = 5;
const MESSAGE_KIND_OFFSET = 4;
const ERROR_MESSAGE = 0;
const DIAGNOSTIC_MESSAGE = 1;
const TIMING_MESSAGE = 2;

const DIAGNOSTIC = Schema.fromJsonString(
  Schema.Struct({
    kind: Schema.Int,
    file_path: Schema.NullOr(Schema.String),
    range: Schema.optionalKey(Schema.Struct({ pos: Schema.Int, end: Schema.Int })),
    rule: Schema.optionalKey(Schema.String),
    message: Schema.Struct({ id: Schema.String, description: Schema.String }),
  }),
);

const FAILURE = Schema.fromJsonString(Schema.Struct({ error: Schema.String }));

export class EnumLintFailed extends Schema.TaggedError<EnumLintFailed>()("EnumLintFailed", {
  reason: Schema.String,
}) {
  public override get message() {
    return `no-unsafe-enum-assignment failed: ${this.reason}`;
  }
}

const decodeMessage = <Message extends Schema.Codec<unknown, string>>(
  schema: Message,
  body: string,
) =>
  Schema.decodeResult(schema)(body).pipe(
    Result.match({
      onFailure: (error) => {
        throw new EnumLintFailed({ reason: error.message });
      },
      onSuccess: (message) => message,
    }),
  );

const nextFrame = (output: Buffer) => {
  if (output.length === 0) {
    return Option.none();
  }
  if (output.length < HEADER_BYTES) {
    throw new EnumLintFailed({ reason: "truncated message header" });
  }
  const end = HEADER_BYTES + output.readUInt32LE(0);
  if (end > output.length) {
    throw new EnumLintFailed({ reason: "truncated message body" });
  }
  const kind = output[MESSAGE_KIND_OFFSET];
  const body = output.subarray(HEADER_BYTES, end).toString("utf8");
  if (kind === ERROR_MESSAGE) {
    throw new EnumLintFailed({
      reason: decodeMessage(FAILURE, body).error,
    });
  }
  const isUnknownKind = kind !== DIAGNOSTIC_MESSAGE && kind !== TIMING_MESSAGE;
  if (isUnknownKind) {
    throw new EnumLintFailed({ reason: `unknown message kind ${kind}` });
  }
  const diagnostics = kind === DIAGNOSTIC_MESSAGE ? [decodeMessage(DIAGNOSTIC, body)] : [];
  return Option.some([diagnostics, output.subarray(end)] as const);
};

export const tsgolintRuleMessages = (output: Buffer) => Arrays.unfold(output, nextFrame).flat();
