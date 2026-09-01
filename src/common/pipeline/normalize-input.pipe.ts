import { Pipe, type ArgumentMetadata, type PipeInterface } from '@nitrostack/core';

function normalize(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalize(entry)]),
    );
  }
  return value;
}

/** Removes accidental whitespace before each tool's Zod schema parses input. */
@Pipe()
export class NormalizeInputPipe implements PipeInterface {
  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    return normalize(value);
  }
}
