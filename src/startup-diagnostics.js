// Parse only Pi's fixed conflict diagnostic grammar. Never expose raw stderr,
// stack traces, arbitrary provider errors or extension-supplied suffixes.
export function startupConflicts(stderr, secrets = []) {
  const clean = stderr.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const conflicts = [];
  for (const line of clean.split(/\r?\n/)) {
    const match = /^(?:Error: )?Failed to load extension "([^"\r\n]+)": Tool "([A-Za-z_][A-Za-z0-9_.:-]{0,127})" conflicts with ([^\r\n]+)$/.exec(line);
    const bare = /^(?:Error: )?Tool "([A-Za-z_][A-Za-z0-9_.:-]{0,127})" conflicts with .+$/.exec(line);
    if (!match && !bare) continue;
    const name = match?.[2] || bare[1];
    const tool = secrets.some(secret => secret && name.includes(secret)) ? '[redacted]' : name;
    conflicts.push({ tool, ...(match ? { source: match[1], owner: match[3] } : {}),
      message: `Tool "${tool}" conflicts with another registered tool. Check enabled extensions.` });
    if (conflicts.length >= 32) break;
  }
  return conflicts;
}
