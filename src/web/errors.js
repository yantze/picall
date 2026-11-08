import { createHash } from 'node:crypto';

export class Fault extends Error {
  constructor(code, status = 400, details) {
    super(details ? code + ' ' + JSON.stringify(details) : code);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function fail(code, status = 400) {
  throw new Fault(code, status);
}

export async function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

