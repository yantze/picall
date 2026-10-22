import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DefaultPackageManager,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';

// Keep the same order as Pi 1.4's CLI built-in extension factories.
const BUILTIN_EXTENSIONS = ['llama.cpp', 'codemode', 'tool-search', 'mcp'];
const runtimeExtension = fileURLToPath(new URL('./extensions/runtime.mjs', import.meta.url));

async function canonicalPath(path, cwd) {
  if (path.startsWith('builtin:')) return path;
  const absolute = resolve(cwd, path);
  try { return await realpath(absolute); }
  catch { return absolute; }
}

function isProjectTrusted(cwd, agentDir, projectTrust) {
  if (projectTrust === 'allow') return true;
  if (projectTrust === 'deny') return false;
  if (projectTrust !== 'default') return false;
  if (!hasTrustRequiringProjectResources(cwd)) return true;
  const saved = new ProjectTrustStore(agentDir).get(cwd);
  if (saved !== null) return saved;
  // Reading settings must not load project resources to decide whether to trust
  // them. Dynamic extension project_trust handlers are intentionally not run.
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  return settings.getDefaultProjectTrust() === 'always';
}

export async function discoverExtensions({
  workdir,
  projectTrust = 'default',
  enableExtensions = true,
  extensionOverrides = {},
}, { agentDir: explicitAgentDir } = {}) {
  const cwd = resolve(workdir || process.cwd());
  const configuredDir = explicitAgentDir || process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
  const agentDir = resolve(cwd, configuredDir === '~' ? homedir() : configuredDir.replace(/^~[/\\]/, `${homedir()}/`));
  const projectTrusted = isProjectTrusted(cwd, agentDir, projectTrust);
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
  const manager = new DefaultPackageManager({
    cwd, agentDir, settingsManager, builtinExtensions: BUILTIN_EXTENSIONS,
  });
  // Resolve paths and package manifests only. Never import extension modules or
  // install missing packages merely to render the management page.
  const { extensions } = await manager.resolve(async () => 'skip');
  const internalPath = await canonicalPath(runtimeExtension, cwd);
  const entries = new Map();
  for (const resource of extensions) {
    // SettingsManager and PackageManager already exclude untrusted project
    // resources. Keep this boundary explicit before paths can become CLI -e.
    if (!projectTrusted && resource.metadata.scope === 'project') continue;
    const path = await canonicalPath(resource.path, cwd);
    if (path === internalPath) continue;
    const previous = entries.get(path);
    if (previous) {
      previous.configuredEnabled ||= resource.enabled === true;
      continue;
    }
    entries.set(path, {
      id: path,
      name: path.startsWith('builtin:') ? path.slice('builtin:'.length) : basename(path),
      path,
      scope: resource.metadata.scope,
      origin: resource.metadata.origin,
      configuredEnabled: resource.enabled === true,
    });
  }
  return [...entries.values()].map(entry => {
    const override = extensionOverrides && Object.hasOwn(extensionOverrides, entry.id)
      ? extensionOverrides[entry.id] : undefined;
    return { ...entry, enabled: enableExtensions !== false &&
      (typeof override === 'boolean' ? override : entry.configuredEnabled) };
  });
}
