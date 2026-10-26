import { createHash } from 'node:crypto';

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function exactMatch(source: Buffer, suspect: Buffer): boolean {
  return source.length === suspect.length && source.equals(suspect);
}
