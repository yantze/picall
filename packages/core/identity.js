export const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export async function identityFingerprint(value) {
  const raw = new TextEncoder().encode(JSON.stringify(canonical(value)));
  const bytes = await crypto.subtle.digest('SHA-256', raw);
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,'0')).join('');
}
