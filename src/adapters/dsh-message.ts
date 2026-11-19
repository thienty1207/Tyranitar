import { randomUUID } from "node:crypto";

export type TyrantUserMessageInput<TContent, TSource> = {
  content: TContent;
  source: TSource;
};

export type TyrantUserMessage<TContent, TSource> = {
  id: string;
  role: "user";
  content: TContent;
  source: TSource;
};

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

/** Build the same immutable user-message envelope DSH's createUserMessage helper emits. */
export function createTyrantUserMessage<TContent, TSource>(
  input: TyrantUserMessageInput<TContent, TSource>,
): TyrantUserMessage<TContent, TSource> {
  const message = structuredClone({
    ...input,
    role: "user" as const,
    id: randomUUID(),
  });
  return deepFreeze(message);
}
