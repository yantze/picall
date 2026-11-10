import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Never consult the developer's real Pi profile, even during model discovery.
const profile = mkdtempSync(join(tmpdir(), 'picall-test-profile-'));
process.env.PI_CODING_AGENT_DIR = profile;
process.env.PI_OFFLINE = '1';
process.on('exit', () => rmSync(profile, { recursive: true, force: true }));
