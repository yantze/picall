
export class Fault extends Error {
  constructor(code, status = 400, details) {
    super(details ? code + ' ' + JSON.stringify(details) : code);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** @returns {never} */
export function fail(code, status = 400) {
  throw new Fault(code, status);
}

export async function hash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

