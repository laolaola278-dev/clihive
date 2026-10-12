// Plugin registry: collection-level configuration injected into every managed
// CLI turn without registering extra agents.
//
// A "collection configuration" is one JSON file per plugin under
// <hiveHome>/plugins/. Loading merges them into an ordered, validated set.
// Every managed agent turn then receives:
//   - skills: named prompt fragments (injected as their own prompt section)
//   - agentPrompt: free-form extra guidance appended to the identity block
//   - historyTurns: how many of this agent's OWN past task results ride along
//   - providers: [] means "all CLIs"; otherwise only the listed ones
// This makes a plugin usable by the leading CLI and by every other managed
// CLI at once — no per-CLI agents need to be created.
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { CollaborationError, requiredText } from './collaboration-validation.js';

const MAX_PLUGIN_BYTES = 512 * 1024;
const MAX_PROMPT_CHARS = 16000;
const MAX_SKILLS = 32;
const MAX_HISTORY_TURNS = 20;
export const PLUGIN_PROVIDERS = Object.freeze(['codex', 'claude', 'opencode']);

function pluginError(message, statusCode = 400, code = 'INVALID_PLUGIN') {
  return new CollaborationError(message, statusCode, code);
}

/**
 * Validate one plugin document (already JSON-parsed). Returns a frozen,
 * normalized copy. Unknown fields are rejected so a typo cannot silently
 * disable a plugin.
 */
export function validatePlugin(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw pluginError('plugin must be a JSON object');
  }
  for (const key of Object.keys(input)) {
    if (!['name', 'version', 'description', 'skills', 'agentPrompt', 'historyTurns', 'providers'].includes(key)) {
      throw pluginError(`unknown plugin field: ${key}`);
    }
  }
  const name = requiredText(input.name, 'plugin.name', 120);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw pluginError('plugin.name must be lowercase letters, digits, and dashes (start alphanumeric)');
  }
  const version = requiredText(input.version, 'plugin.version', 40);
  if (!/^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?$/.test(version)) {
    throw pluginError('plugin.version must look like semver (e.g. 1.0.0)');
  }
  const description = input.description === undefined || input.description === null || input.description === ''
    ? null
    : requiredText(input.description, 'plugin.description', 2000);

  const skills = [];
  const rawSkills = input.skills === undefined || input.skills === null ? [] : input.skills;
  if (!Array.isArray(rawSkills)) throw pluginError('plugin.skills must be an array');
  if (rawSkills.length > MAX_SKILLS) throw pluginError(`plugin.skills supports at most ${MAX_SKILLS} entries`);
  const seen = new Set();
  for (const raw of rawSkills) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw pluginError('each skill must be an object');
    for (const key of Object.keys(raw)) {
      if (!['name', 'prompt'].includes(key)) throw pluginError(`unknown skill field: ${key}`);
    }
    const skillName = requiredText(raw.name, 'skill.name', 120);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(skillName)) {
      throw pluginError('skill.name is invalid (alphanumeric start; letters, digits, . _ -)');
    }
    if (seen.has(skillName)) throw pluginError(`duplicate skill name: ${skillName}`);
    seen.add(skillName);
    skills.push({ name: skillName, prompt: requiredText(raw.prompt, `skill ${skillName} prompt`, MAX_PROMPT_CHARS) });
  }

  const agentPrompt = input.agentPrompt === undefined || input.agentPrompt === null || input.agentPrompt === ''
    ? null
    : requiredText(input.agentPrompt, 'plugin.agentPrompt', MAX_PROMPT_CHARS);

  let historyTurns = 0;
  if (input.historyTurns !== undefined && input.historyTurns !== null) {
    if (!Number.isSafeInteger(input.historyTurns) || input.historyTurns < 0 || input.historyTurns > MAX_HISTORY_TURNS) {
      throw pluginError(`plugin.historyTurns must be an integer between 0 and ${MAX_HISTORY_TURNS}`);
    }
    historyTurns = input.historyTurns;
  }

  let providers = [];
  if (input.providers !== undefined && input.providers !== null) {
    if (!Array.isArray(input.providers)) throw pluginError('plugin.providers must be an array');
    providers = input.providers.map((p) => {
      const value = requiredText(p, 'plugin.providers entry', 40);
      if (!PLUGIN_PROVIDERS.includes(value)) {
        throw pluginError(`plugin.providers supports only ${PLUGIN_PROVIDERS.join(', ')} (got ${value})`);
      }
      return value;
    });
    if (new Set(providers).size !== providers.length) throw pluginError('plugin.providers contains duplicates');
  }

  return Object.freeze({
    name, version, description, skills: Object.freeze(skills),
    agentPrompt, historyTurns, providers: Object.freeze(providers),
  });
}

/**
 * Merge validated plugins into prompt material for one agent turn.
 * Plugins with a providers filter apply only to that provider; [] = all.
 * Returns { skills, agentPrompt, historyTurns } ready for buildTurnPrompt.
 */
export function pluginsForTurn(plugins, { provider }) {
  const applicable = (plugins ?? []).filter((p) => !p.providers?.length || p.providers.includes(provider));
  const skills = [];
  for (const p of applicable) {
    for (const s of p.skills) skills.push({ ...s, plugin: p.name });
  }
  const prompts = applicable.filter((p) => p.agentPrompt).map((p) => p.agentPrompt);
  const historyTurns = applicable.reduce((max, p) => Math.max(max, p.historyTurns ?? 0), 0);
  return { skills, agentPrompt: prompts.join('\n\n') || null, historyTurns };
}

export class PluginRegistry {
  /** @param {string} directory plugins directory (hive home by default). */
  constructor(directory) {
    this.directory = path.resolve(directory);
  }

  async #ensureDir() {
    await mkdir(this.directory, { recursive: true });
  }

  #pluginPath(name) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw pluginError('invalid plugin name');
    // name is regex-confined, so it cannot carry path separators.
    return path.join(this.directory, `${name}.json`);
  }

  /** Load and validate every plugin. A malformed file is a hard error: a
   *  half-loaded plugin set would silently change what agents are told. */
  async load() {
    await this.#ensureDir();
    const files = (await readdir(this.directory)).filter((f) => f.toLowerCase().endsWith('.json')).sort();
    const plugins = [];
    const seen = new Set();
    for (const file of files) {
      const full = path.join(this.directory, file);
      const stat = await readFile(full).then((buf) => buf.length).catch(() => null);
      if (stat === null) continue; // raced away between readdir and read
      if (stat > MAX_PLUGIN_BYTES) throw pluginError(`plugin file too large: ${file}`);
      let parsed;
      try {
        parsed = JSON.parse(await readFile(full, 'utf8'));
      } catch (err) {
        throw pluginError(`plugin file ${file} is not valid JSON: ${err.message}`, 500, 'PLUGIN_LOAD_FAILED');
      }
      const plugin = validatePlugin(parsed);
      if (seen.has(plugin.name)) throw pluginError(`duplicate plugin name: ${plugin.name}`);
      seen.add(plugin.name);
      plugins.push(plugin);
    }
    return plugins;
  }

  async save(plugin) {
    const validated = validatePlugin(plugin);
    await this.#ensureDir();
    const target = this.#pluginPath(validated.name);
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    const body = JSON.stringify(validated, null, 2);
    await writeFile(temp, body, 'utf8');
    await rename(temp, target); // atomic on the same volume
    return validated;
  }

  async remove(name) {
    const target = this.#pluginPath(requiredText(name, 'plugin name', 64));
    if (!existsSync(target)) throw pluginError(`unknown plugin: ${name}`, 404, 'PLUGIN_NOT_FOUND');
    const { unlink } = await import('node:fs/promises');
    await unlink(target);
    return true;
  }

  async get(name) {
    const target = this.#pluginPath(requiredText(name, 'plugin name', 64));
    if (!existsSync(target)) return null;
    return validatePlugin(JSON.parse(await readFile(target, 'utf8')));
  }
}
