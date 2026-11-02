import { access, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const name = 'skill-manager';
// `skills` is hard-injectable; the optional services `workspaceRegistry` and
// `workingDirectory` are read through `ctx.get(...)` with an undefined check so
// the module also runs where the web layer is absent.
const inject = ['commands', 'skills'];
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ---- skill scopes and DSH source roots ----
// These mirror the directory layout the built-in `dsh-skill-filesystem`
// provider reads, so the manager edits exactly what the harness loads.
//   personal: user-dsh -> $DSH_HOME/skills, user-agents -> $DSH_AGENTS_HOME/skills
//   project:  project-dsh -> <P>/.dsh/skills, project-agents -> <P>/.agents/skills
// where `<P>` is the nearest ancestor of the workspace path that contains a
// `.git` entry (or the workspace path itself when none does).

const SCOPES = ['personal', 'project'];
const SCOPES_SET = new Set(SCOPES);
const PRIMARY_SOURCE = { personal: 'user-dsh', project: 'project-dsh' };

/** Lower rank wins a same-name collision inside one view. */
const SOURCE_RANK = {
  'project-dsh': 100,
  'project-agents': 200,
  runtime: 250,
  custom: 300,
  'user-dsh': 400,
  'user-agents': 500,
  bundled: 600,
};
const UNKNOWN_RANK = 1000;
const PROJECT_SOURCES = new Set(['project-dsh', 'project-agents']);
const READ_ONLY_SOURCES = ['custom', 'bundled', 'runtime'];
const READ_ONLY_SET = new Set(READ_ONLY_SOURCES);
const MANAGED_SOURCES = {
  personal: new Set(['user-dsh', 'user-agents']),
  project: new Set(['project-dsh', 'project-agents']),
};

function rankOf(source) {
  return Object.prototype.hasOwnProperty.call(SOURCE_RANK, source) ? SOURCE_RANK[source] : UNKNOWN_RANK;
}

/** Normalize a path for comparison; Windows paths are case-insensitive. */
function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ra = resolve(a);
  const rb = resolve(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/**
 * Identity of one physical skill file, for collapsing the same file found
 * twice. `realpath` (not just `resolve`) so a junctioned or symlinked root --
 * e.g. `~/.agents/skills` aliasing `~/.dsh/skills` -- does not list every skill
 * twice; `resolve` is the fallback for a path that vanished mid-scan.
 */
function pathKey(p) {
  let r;
  try { r = realpathSync.native(p); } catch { r = resolve(p); }
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** `dir` | `file` from a skill path, without hitting the filesystem. */
function skillKind(skillPath) {
  if (typeof skillPath !== 'string' || skillPath === '') return 'dir';
  return basename(skillPath).toLowerCase() === 'skill.md' ? 'dir' : 'file';
}

/**
 * Project base for a skills directory. `project-agents` must resolve to
 * `<P>/.agents/skills`, so deriving the base from `dirname(projectRoot)` is the
 * bug this replaces: for `<P>/.dsh/skills` it would yield `<P>/.dsh`.
 * @param {string} skillsDir - a `.../skills` directory.
 * @returns {string} the project base `<P>`.
 */
function projectBaseOf(skillsDir) {
  const parent = dirname(skillsDir);
  return basename(parent) === '.dsh' ? dirname(parent) : parent;
}

/**
 * Inline stand-in for `@deepseek-ai/dsh-commands/brand` `CommandDefinitionId`:
 * brands a plugin-namespaced id string, performs no validation. Inlined so this
 * workspace-linked bundle imports nothing outside Node builtins.
 * @param {string} id - stable identity chosen by the registering plugin.
 * @returns {string} the same string, branded.
 */
function CommandDefinitionId(id) {
  return id;
}

/**
 * Default user (personal) skills root: `$DSH_HOME/skills` falling back to
 * `~/.dsh/skills` (same precedence as @deepseek-ai/dsh-home-paths).
 */
function defaultPersonalRoot() {
  const envHome = process.env.DSH_HOME;
  const base = typeof envHome === 'string' && envHome.trim().length > 0 ? envHome : join(homedir(), '.dsh');
  return resolve(join(base, 'skills'));
}

/**
 * Default shared agent home: `$DSH_AGENTS_HOME` falling back to `~/.agents`.
 */
function defaultAgentsHome() {
  const envHome = process.env.DSH_AGENTS_HOME;
  const base = typeof envHome === 'string' && envHome.trim().length > 0 ? envHome : join(homedir(), '.agents');
  return resolve(base);
}

/**
 * Find the project root for a working directory: the nearest ancestor that
 * contains a `.git` entry, or `cwd` itself when none exists. Mirrors
 * `dsh-skill-filesystem` `findProjectRoot`, but synchronous for plugin apply.
 */
function findProjectRootSync(cwd) {
  let current = cwd;
  while (true) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
}

/**
 * Build the static managed roots from config, with DSH defaults. Project roots
 * that depend on workspace enumeration are added lazily by `getInfo()` and the
 * discovery methods; this list only contains the roots known at apply time.
 *
 * Config keys (read from `config`, no schema dependency):
 * - `personalRoot` (string): primary personal (user) skills dir. Alias `root`.
 * - `personalAgentsRoot` (string): shared `~/.agents`-style personal skills dir.
 * - `includeAgentsRoots` (boolean, default true): include the `*-agents` roots.
 * - `enableProject` (boolean, default true): expose the `project` scope at all.
 * - `projectRoot` (string): explicit project-dsh skills dir. When set it
 *   DISABLES workspace enumeration and this single project is listed.
 * - `projectAgentsRoot` (string): explicit project-agents skills dir; otherwise
 *   `<projectBase>/.agents/skills`.
 *
 * @param {object} [config] - plugin config.
 * @returns {{scope: string, source: string, path: string}[]} ordered roots.
 */
function buildRoots(config = {}) {
  const includeAgents = config.includeAgentsRoots !== false;
  // Backwards-compatible alias: the previous single-root config key `root` sets the personal root.
  const personalRoot = resolve(
    (typeof config.personalRoot === 'string' && config.personalRoot.trim() ? config.personalRoot
      : (typeof config.root === 'string' && config.root.trim() ? config.root : defaultPersonalRoot())).trim());
  const personalAgentsRoot = resolve(typeof config.personalAgentsRoot === 'string' && config.personalAgentsRoot.trim()
    ? config.personalAgentsRoot.trim()
    : join(defaultAgentsHome(), 'skills'));

  const roots = [{ scope: 'personal', source: 'user-dsh', path: personalRoot }];
  if (includeAgents) roots.push({ scope: 'personal', source: 'user-agents', path: personalAgentsRoot });

  if (config.enableProject !== false) {
    const explicit = typeof config.projectRoot === 'string' && config.projectRoot.trim() ? resolve(config.projectRoot.trim()) : null;
    if (explicit) {
      roots.push({ scope: 'project', source: 'project-dsh', path: explicit });
      if (includeAgents) {
        const agents = typeof config.projectAgentsRoot === 'string' && config.projectAgentsRoot.trim()
          ? resolve(config.projectAgentsRoot.trim())
          : join(projectBaseOf(explicit), '.agents', 'skills');
        roots.push({ scope: 'project', source: 'project-agents', path: agents });
      }
    }
  }
  return roots;
}

// ---- dependency-free YAML frontmatter codec ----
// Skill files use flat `key: value` frontmatter. This codec edits managed keys
// line-wise and preserves every other frontmatter line verbatim, so unknown or
// complex entries survive create/update/toggle round trips.

const FM_KEY = /^([A-Za-z][A-Za-z0-9_-]*)\s*:(.*)$/;

function splitFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (!m) return null;
  return { lines: m[1].split(/\r?\n/), body: raw.slice(m[0].length).trim() };
}

function unquoteScalar(text) {
  const s = text.trim();
  if (s.length >= 2 && s[0] === "'" && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.length >= 2 && s[0] === '"') { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
  return s;
}

function toScalar(text) {
  const s = unquoteScalar(text);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  return s;
}

function quoteScalar(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const s = String(value);
  if (s === '') return "''";
  const plain = !/[\r\n"#]/.test(s)
    && !s.includes(': ')
    && !s.includes(' #')
    && !/^[\s&*!|>%@`'\-?,[\]{}]/.test(s)
    && !/\s$/.test(s);
  const risky = s === 'true' || s === 'false' || s === 'null' || s === '~';
  return plain && !risky ? s : JSON.stringify(s);
}

function collectIndented(lines, from) {
  const out = [];
  for (let i = from; i < lines.length && /^\s/.test(lines[i]); i++) out.push(lines[i]);
  return out;
}

/** Locate one top-level frontmatter key; returns { index, span, value } or null. */
function fmEntry(lines, key) {
  for (let i = 0; i < lines.length; i++) {
    const m = FM_KEY.exec(lines[i]);
    if (!m || m[1] !== key) continue;
    const inline = m[2].trim();
    if (inline === '') {
      const cont = collectIndented(lines, i + 1);
      return { index: i, span: 1 + cont.length, value: null };
    }
    if (/^[|>][+-]?$/.test(inline)) {
      const cont = collectIndented(lines, i + 1).map((l) => l.replace(/^\s+/, ''));
      const value = inline[0] === '>' ? cont.join(' ') : cont.join('\n');
      return { index: i, span: 1 + cont.length, value };
    }
    const cont = collectIndented(lines, i + 1);
    const value = cont.length === 0
      ? toScalar(inline)
      : [unquoteScalar(inline), ...cont.map((l) => l.trim())].join(' ');
    return { index: i, span: 1 + cont.length, value };
  }
  return null;
}

/** Read a simple top-level frontmatter view (first occurrence of each key wins). */
function fmView(lines) {
  const meta = {};
  for (const line of lines) {
    const m = FM_KEY.exec(line);
    if (!m || Object.prototype.hasOwnProperty.call(meta, m[1])) continue;
    const entry = fmEntry(lines, m[1]);
    if (entry) meta[m[1]] = entry.value;
  }
  return meta;
}

/** Set or remove (`value === undefined`) a top-level key, preserving other lines. */
function fmSet(lines, key, value) {
  const entry = fmEntry(lines, key);
  if (value === undefined) {
    if (entry) lines.splice(entry.index, entry.span);
    return lines;
  }
  const line = key + ': ' + quoteScalar(value);
  if (entry) lines.splice(entry.index, entry.span, line);
  else lines.push(line);
  return lines;
}

function parseSkillFile(raw) {
  const split = splitFrontmatter(raw);
  if (!split) return { ok: false, reason: 'no YAML frontmatter' };
  return { ok: true, lines: split.lines, meta: fmView(split.lines), body: split.body };
}

function serializeSkillFile(lines, body) {
  const copy = [...lines];
  while (copy.length > 0 && copy[copy.length - 1].trim() === '') copy.pop();
  return '---\n' + copy.join('\n') + '\n---\n\n' + (body || '').trim() + '\n';
}

async function pathExists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function locate(root, skillName) {
  const dirPath = join(root, skillName);
  const dirSkill = join(dirPath, 'SKILL.md');
  if (await pathExists(dirSkill)) return { kind: 'dir', dir: dirPath, skillPath: dirSkill };
  const flat = join(root, skillName + '.md');
  if (await pathExists(flat)) return { kind: 'file', dir: root, skillPath: flat };
  return null;
}

async function readOrNull(p) {
  try { return await readFile(p, 'utf8'); } catch { return null; }
}

/**
 * Pull a body out of whatever shape a `skills.get()` SkillDefinition uses.
 * Returns `undefined` when none of the known body-bearing fields is a string.
 */
function definitionBody(def) {
  if (!def || typeof def !== 'object') return undefined;
  for (const key of ['body', 'content', 'markdown', 'text']) {
    if (typeof def[key] === 'string') return def[key];
  }
  return undefined;
}

/** Mark every same-key row except the lowest-rank winner as shadowed. */
function markShadowed(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const list = groups.get(key);
    if (list) list.push(row); else groups.set(key, [row]);
  }
  for (const list of groups.values()) {
    if (list.length === 1) { list[0].shadowed = false; continue; }
    let winner = list[0];
    for (const row of list) if (row.rank < winner.rank) winner = row;
    for (const row of list) row.shadowed = row !== winner;
  }
}

const byRankThenName = (a, b) => (a.rank - b.rank) || a.name.localeCompare(b.name);
const byProjectOrder = (a, b) =>
  String(a.workspaceTitle ?? a.workspacePath ?? '').localeCompare(String(b.workspaceTitle ?? b.workspacePath ?? ''))
  || (a.rank - b.rank) || a.name.localeCompare(b.name);

const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';
const SERVICE_KEY = 'skillManager';

class SkillManagerService {
  /**
   * @param {object} ctx - plugin context; optional services are read lazily via `ctx.get`.
   * @param {object} [config] - plugin config, see {@link buildRoots}.
   */
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.config = config || {};
    this.includeAgentsRoots = this.config.includeAgentsRoots !== false;
    this.enableProject = this.config.enableProject !== false;

    const staticRoots = buildRoots(this.config);
    this.roots = staticRoots;
    const primaryPersonal = staticRoots.find((r) => r.source === 'user-dsh')
      || staticRoots.find((r) => r.scope === 'personal');
    this.root = primaryPersonal.path;
    this.personalRoot = this.root;
    this.personalAgentsRoot = staticRoots.find((r) => r.source === 'user-agents')?.path;
    this.personalRoots = staticRoots.filter((r) => r.scope === 'personal').map((r) => ({ source: r.source, path: r.path }));

    this.explicitProjectRoot = typeof this.config.projectRoot === 'string' && this.config.projectRoot.trim()
      ? resolve(this.config.projectRoot.trim()) : null;
    this.explicitProjectBase = this.explicitProjectRoot ? projectBaseOf(this.explicitProjectRoot) : null;
    this.configProjectAgentsRoot = typeof this.config.projectAgentsRoot === 'string' && this.config.projectAgentsRoot.trim()
      ? resolve(this.config.projectAgentsRoot.trim()) : null;

    const staticProject = staticRoots.find((r) => r.source === 'project-dsh');
    // Backward-compatible single-root view of the primary project location.
    this.projectRoot = staticProject ? staticProject.path : void 0;

    // SRC-mode binding consumed by the Typert Gateway's source discovery.
    // Same shape bindTypertRemote() produces; inlined to stay dependency-free.
    this.typertRemote = Object.freeze({ service: this, serviceKey: SERVICE_KEY, namespace: SERVICE_KEY });
  }

  /** Read an optional Cordis service, never throwing when absent. */
  _service(key) {
    const ctx = this.ctx;
    if (!ctx || typeof ctx.get !== 'function') return null;
    try {
      const value = ctx.get(key);
      return value === undefined ? null : value;
    } catch { return null; }
  }

  /** The hard-injected skills discovery service, or null in fs-scan fallback. */
  _skillsService() {
    const skills = this._service('skills');
    return skills && typeof skills.snapshot === 'function' ? skills : null;
  }

  normalizeScope(scope) {
    if (scope === undefined || scope === null || scope === '') scope = 'personal';
    if (!SCOPES_SET.has(String(scope))) throw new Error('unknown scope "' + scope + '" - use "personal" or "project"');
    return String(scope);
  }

  // ---- workspace model -------------------------------------------------

  async _statusOf(ws) {
    if (typeof ws.status === 'function') {
      try { const s = await ws.status(); return s === 'missing-dir' ? 'missing-dir' : 'ok'; } catch { return 'ok'; }
    }
    return ws.status === 'missing-dir' ? 'missing-dir' : 'ok';
  }

  /** Canonical `<P>/.dsh/skills` + `<P>/.agents/skills` roots for a project base. */
  _projectRootsFor(base) {
    const roots = [{ source: 'project-dsh', path: join(base, '.dsh', 'skills') }];
    if (this.includeAgentsRoots) {
      roots.push({ source: 'project-agents', path: this.configProjectAgentsRoot || join(base, '.agents', 'skills') });
    }
    return roots;
  }

  /** Roots for the explicit single-project config override. */
  _explicitProjectRoots() {
    const roots = [{ source: 'project-dsh', path: this.explicitProjectRoot }];
    if (this.includeAgentsRoots) {
      roots.push({
        source: 'project-agents',
        path: this.configProjectAgentsRoot || join(this.explicitProjectBase, '.agents', 'skills'),
      });
    }
    return roots;
  }

  _workspaceEntry({ id, title, path, status, base, roots }) {
    const projectBase = base ?? findProjectRootSync(resolve(path));
    const entries = roots ?? this._projectRootsFor(projectBase);
    return {
      id,
      title,
      path,
      status,
      base: projectBase,
      roots: entries.map((r) => ({ scope: 'project', source: r.source, path: r.path, exists: existsSync(r.path) })),
    };
  }

  /**
   * Enumerate workspaces. Explicit `config.projectRoot` wins outright and
   * disables workspace enumeration; otherwise `workspaceRegistry.list()` is
   * used, and a final fallback synthesizes the cwd (or `workingDirectory.
   * defaultDirectory`) so a non-web host can still manage its project.
   */
  async _workspaces() {
    if (this.enableProject !== true) return [];
    if (this.explicitProjectRoot) {
      const base = this.explicitProjectBase;
      return [this._workspaceEntry({
        id: base,
        title: basename(base) || base,
        path: base,
        status: existsSync(this.explicitProjectRoot) ? 'ok' : 'missing-dir',
        base,
        roots: this._explicitProjectRoots(),
      })];
    }

    const registry = this._service('workspaceRegistry');
    if (registry && typeof registry.list === 'function') {
      let list = [];
      try { const result = await registry.list(); if (Array.isArray(result)) list = result; } catch { list = []; }
      const out = [];
      for (const ws of list) {
        if (!ws || typeof ws.path !== 'string' || !ws.path.trim()) continue;
        const path = ws.path;
        const title = typeof ws.title === 'string' && ws.title.trim() ? ws.title
          : (typeof ws.name === 'string' && ws.name.trim() ? ws.name : (basename(resolve(path)) || path));
        const id = ws.id !== undefined && ws.id !== null && String(ws.id) !== '' ? String(ws.id) : path;
        out.push(this._workspaceEntry({ id, title, path, status: await this._statusOf(ws) }));
      }
      return out;
    }

    const workingDirectory = this._service('workingDirectory');
    const dir = workingDirectory && typeof workingDirectory.defaultDirectory === 'string' && workingDirectory.defaultDirectory.trim()
      ? workingDirectory.defaultDirectory
      : process.cwd();
    const path = resolve(dir);
    return [this._workspaceEntry({ id: path, title: basename(path) || path, path, status: existsSync(path) ? 'ok' : 'missing-dir' })];
  }

  /** Resolve one workspace by path/base/root; throws when an explicit path is unknown. */
  async _workspaceFor(workspacePath) {
    const all = await this._workspaces();
    if (workspacePath !== undefined && workspacePath !== null && String(workspacePath).trim() !== '') {
      const target = resolve(String(workspacePath).trim());
      const ws = all.find((w) => samePath(w.path, target) || samePath(w.base, target)
        || w.roots.some((r) => samePath(r.path, target)));
      if (!ws) throw new Error('unknown workspace "' + workspacePath + '"');
      return ws;
    }
    if (all.length > 0) return all[0];
    throw new Error('no workspace is available to resolve the project root');
  }

  /** Live target workspaces for a project view (missing dirs are hidden). */
  async _projectTargets(workspacePath) {
    const all = await this._workspaces();
    if (workspacePath !== undefined && workspacePath !== null && String(workspacePath).trim() !== '') {
      const target = resolve(String(workspacePath).trim());
      const ws = all.find((w) => samePath(w.path, target) || samePath(w.base, target)
        || w.roots.some((r) => samePath(r.path, target)));
      return ws && ws.status !== 'missing-dir' ? [ws] : [];
    }
    return all.filter((w) => w.status !== 'missing-dir');
  }

  // ---- info ------------------------------------------------------------

  async getInfo() {
    const workspaces = await this._workspaces();
    const primary = workspaces[0];
    const projectRoots = primary ? primary.roots : [];
    return {
      name,
      scopes: [...SCOPES],
      personalRoot: this.personalRoot,
      projectRoot: primary ? (primary.roots.find((r) => r.source === 'project-dsh') || {}).path : undefined,
      roots: [
        ...this.personalRoots.map((r) => ({ scope: 'personal', source: r.source, path: r.path })),
        ...projectRoots.map((r) => ({ scope: 'project', source: r.source, path: r.path })),
      ],
      personalRoots: this.personalRoots.map((r) => ({ source: r.source, path: r.path })),
      workspaces: workspaces.map((w) => ({
        id: w.id,
        title: w.title,
        path: w.path,
        status: w.status,
        roots: w.roots.map((r) => ({ source: r.source, path: r.path, exists: r.exists })),
      })),
      skillsService: !!this._skillsService(),
      readOnlySources: [...READ_ONLY_SOURCES],
      config: { personalRoot: this.personalRoot, includeAgentsRoots: this.includeAgentsRoots },
    };
  }

  // ---- discovery -------------------------------------------------------

  /**
   * Filesystem fallback: scan one root. A readdir failure is reported as
   * `complete: false` instead of being swallowed into an empty result; a root
   * that simply does not exist is authoritatively empty (`complete: true`) and
   * is reported as `exists: false`.
   */
  async _listRoot(root) {
    const exists = existsSync(root.path);
    let entries;
    try {
      entries = await readdir(root.path);
    } catch {
      return { rows: [], complete: !exists, exists };
    }
    const out = [];
    for (const entry of entries) {
      // `.system` is only special where the shipped provider skips it (user-dsh).
      if (entry === '.system' && root.source === 'user-dsh') continue;
      const full = join(root.path, entry);
      let st;
      try { st = await stat(full); } catch { continue; }
      let skillPath; let kind;
      if (st.isDirectory()) {
        const sp = join(full, 'SKILL.md');
        if (!(await pathExists(sp))) continue;
        skillPath = sp; kind = 'dir';
      } else if (entry.endsWith('.md')) {
        skillPath = full; kind = 'file';
      } else { continue; }
      const raw = await readOrNull(skillPath);
      if (raw === null) continue;
      const parsed = parseSkillFile(raw);
      if (!parsed.ok) continue;
      if (typeof parsed.meta.name !== 'string') continue;
      const mi = parsed.meta['disable-model-invocation'] !== true;
      const ui = parsed.meta['user-invocable'] !== false;
      const source = String(root.source);
      out.push({
        name: parsed.meta.name,
        description: typeof parsed.meta.description === 'string' ? parsed.meta.description : '',
        whenToUse: typeof parsed.meta.whenToUse === 'string' ? parsed.meta.whenToUse : void 0,
        modelInvocable: mi, userInvocable: ui, enabled: mi && ui,
        kind, path: skillPath, scope: root.scope, source,
        provider: void 0,
        rank: rankOf(source),
        shadowed: false,
        readOnly: root.scope === 'project' ? !skillPath : (READ_ONLY_SET.has(source) || !skillPath),
        complete: true,
      });
    }
    return { rows: out, complete: true, exists };
  }

  /** Turn one `skills.snapshot()` SkillSummary into a view row. */
  _rowFromSummary(summary, scope, complete, ws) {
    const s = summary || {};
    const source = s.source !== undefined && s.source !== null && String(s.source) !== '' ? String(s.source) : 'unknown';
    const invocation = s.invocation || {};
    const mi = invocation.modelInvocable !== false;
    const ui = invocation.userInvocable !== false;
    const skillPath = typeof s.path === 'string' && s.path ? s.path : void 0;
    const row = {
      name: String(s.name ?? ''),
      description: typeof s.description === 'string' ? s.description : '',
      whenToUse: typeof s.whenToUse === 'string' ? s.whenToUse : void 0,
      modelInvocable: mi, userInvocable: ui, enabled: mi && ui,
      kind: skillKind(skillPath),
      path: skillPath,
      scope,
      source,
      provider: typeof s.provider === 'string' ? s.provider : void 0,
      rank: rankOf(source),
      shadowed: false,
      readOnly: scope === 'project' ? !skillPath : (READ_ONLY_SET.has(source) || !skillPath),
      complete,
    };
    if (ws) {
      row.workspaceId = ws.id;
      row.workspaceTitle = ws.title;
      row.workspacePath = ws.path;
    }
    return row;
  }

  async _snapshot(skills, cwd) {
    try {
      const snap = await skills.snapshot(cwd === undefined ? {} : { cwd });
      return snap && typeof snap === 'object' ? snap : { skills: [], complete: false };
    } catch {
      return { skills: [], complete: false };
    }
  }

  /**
   * Personal rows = a filesystem scan of every personal root UNIONed with the
   * skills-service snapshot.
   *
   * The scan is primary on purpose. This plugin is a profile-level (host) row,
   * and a read with no `scope` merges only the GLOBAL layer, while a shipped
   * filesystem provider mounted by an agent preset registers into that preset's
   * layer -- so a host-level `snapshot()` can legitimately observe nothing while
   * the managed directories are full. Relying on the snapshot alone made the
   * personal view silently empty. The snapshot is still merged in because it is
   * the only view of sources with no root here (`custom`, `bundled`, `runtime`)
   * and it can surface a root this process does not know about.
   */
  async _discoverPersonal() {
    const fsRows = [];
    const seenPaths = new Set();
    const diskNames = new Set();
    let fsComplete = true;
    for (const root of this.personalRoots) {
      const res = await this._listRoot({ scope: 'personal', source: root.source, path: root.path });
      if (!res.complete) fsComplete = false;
      for (const row of res.rows) {
        // Collapse by PHYSICAL FILE, never by name: two directories in one root
        // may legitimately declare the same name, and both must stay listed --
        // `markShadowed` flags the loser instead of hiding it. The same file
        // reachable from two roots (e.g. misconfigured equal roots) is one row.
        const pk = row.path ? pathKey(row.path) : null;
        if (pk !== null) {
          if (seenPaths.has(pk)) continue;
          seenPaths.add(pk);
        }
        diskNames.add(row.source + '\u0000' + row.name);
        fsRows.push(row);
      }
    }
    for (const row of fsRows) row.complete = fsComplete;

    const svcRows = [];
    const svcSeen = new Set();
    const skills = this._skillsService();
    if (skills) {
      const snap = await this._snapshot(skills);
      const complete = snap.complete !== false;
      for (const summary of (Array.isArray(snap.skills) ? snap.skills : [])) {
        const source = String(summary?.source ?? '');
        if (PROJECT_SOURCES.has(source)) continue;
        // A snapshot row for a skill already found on disk is the SAME skill:
        // the disk row wins because it carries the real `path`.
        const key = source + '\u0000' + String(summary?.name ?? '');
        if (diskNames.has(key) || svcSeen.has(key)) continue;
        svcSeen.add(key);
        svcRows.push(this._rowFromSummary(summary, 'personal', complete));
      }
    }

    const rows = fsRows.concat(svcRows);
    markShadowed(rows, (r) => r.name);
    rows.sort(byRankThenName);
    return rows;
  }

  /**
   * Project rows = per-workspace filesystem scan UNIONed with the snapshot for
   * that workspace's `cwd`. See {@link _discoverPersonal} for why the scan has
   * to be primary; identity is scoped per workspace, so the same skill name in
   * two projects stays two rows.
   */
  async _discoverProject(workspacePath) {
    const targets = await this._projectTargets(workspacePath);
    const skills = this._skillsService();
    const rows = [];
    for (const ws of targets) {
      const seenPaths = new Set();
      const diskNames = new Set();
      const fsRows = [];
      let fsComplete = true;
      for (const root of ws.roots) {
        const res = await this._listRoot({ scope: 'project', source: root.source, path: root.path });
        if (!res.complete) fsComplete = false;
        for (const row of res.rows) {
          const pk = row.path ? pathKey(row.path) : null;
          if (pk !== null) {
            if (seenPaths.has(pk)) continue;
            seenPaths.add(pk);
          }
          diskNames.add(row.source + '\u0000' + row.name);
          row.workspaceId = ws.id;
          row.workspaceTitle = ws.title;
          row.workspacePath = ws.path;
          fsRows.push(row);
        }
      }
      for (const row of fsRows) row.complete = fsComplete;

      const wsRows = fsRows;
      if (skills) {
        const svcSeen = new Set();
        const snap = await this._snapshot(skills, ws.path);
        const complete = snap.complete !== false;
        for (const summary of (Array.isArray(snap.skills) ? snap.skills : [])) {
          const source = String(summary?.source ?? '');
          if (!PROJECT_SOURCES.has(source)) continue;
          const key = source + '\u0000' + String(summary?.name ?? '');
          if (diskNames.has(key) || svcSeen.has(key)) continue;
          svcSeen.add(key);
          wsRows.push(this._rowFromSummary(summary, 'project', complete, ws));
        }
      }
      rows.push(...wsRows);
    }
    markShadowed(rows, (r) => String(r.workspaceId ?? r.workspacePath ?? '') + '\u0000' + r.name);
    rows.sort(byProjectOrder);
    return rows;
  }

  async list(scope) {
    const sc = this.normalizeScope(scope);
    return sc === 'personal' ? await this._discoverPersonal() : await this._discoverProject();
  }

  // ---- mutations -------------------------------------------------------

  /**
   * Resolve the managed (writable) root for a mutation. Any other source --
   * including unknown ones -- is refused with a clear read-only error.
   * `workspacePath` is required to disambiguate when several projects exist.
   */
  async _managedRoot(scope, source, workspacePath) {
    const sc = this.normalizeScope(scope);
    const requested = source === undefined || source === null || source === '' ? PRIMARY_SOURCE[sc] : String(source);
    if (!MANAGED_SOURCES[sc].has(requested)) {
      throw new Error('skill source "' + requested + '" is read-only');
    }
    if (sc === 'personal') {
      if (requested === 'user-dsh') return { scope: sc, source: requested, path: this.personalRoot };
      if (!this.personalAgentsRoot) throw new Error('skill source "' + requested + '" is not managed');
      return { scope: sc, source: requested, path: this.personalAgentsRoot };
    }
    const ws = await this._workspaceFor(workspacePath);
    const root = ws.roots.find((r) => r.source === requested);
    if (!root) throw new Error('skill source "' + requested + '" is not managed');
    return { scope: sc, source: requested, path: root.path };
  }

  /** cwd to hand to `skills.get()` when reading a project skill. */
  async _cwdForRead(scope, row, workspacePath) {
    if (scope !== 'project') return void 0;
    if (row && row.workspacePath) return row.workspacePath;
    if (workspacePath !== undefined && workspacePath !== null && String(workspacePath).trim() !== '') {
      return resolve(String(workspacePath).trim());
    }
    const targets = await this._projectTargets();
    return targets.length > 0 ? targets[0].path : void 0;
  }

  /**
   * Read one skill. Body comes from `ctx.skills.get(name, { cwd })` when that
   * service is available, otherwise from the file at the row `path`.
   * Read-only sources still read: read-only only blocks writes.
   */
  async read(scope, skillName, source, workspacePath) {
    const sc = this.normalizeScope(scope);
    if (!SKILL_NAME.test(skillName)) throw new Error('invalid skill name: ' + skillName);
    const rows = sc === 'personal' ? await this._discoverPersonal() : await this._discoverProject(workspacePath);
    let candidates = rows.filter((r) => r.name === skillName);
    if (source !== undefined && source !== null && source !== '') {
      candidates = candidates.filter((r) => r.source === String(source));
    }
    // Prefer the winning (lowest-rank) row; a shadowed row is still readable.
    candidates.sort((a, b) => (a.rank - b.rank) || (a.shadowed === b.shadowed ? 0 : (a.shadowed ? 1 : -1)));
    let row = candidates.length > 0 ? candidates[0] : null;

    let body;
    const skills = this._skillsService();
    if (skills && typeof skills.get === 'function') {
      const cwd = await this._cwdForRead(sc, row, workspacePath);
      let definition;
      try { definition = await skills.get(skillName, cwd === undefined ? {} : { cwd }); } catch { definition = void 0; }
      if (definition) {
        const serviced = definitionBody(definition);
        if (typeof serviced === 'string') body = serviced;
        if (!row) {
          const ws = sc === 'project' ? (await this._workspaces()).find((w) => cwd !== void 0 && samePath(w.path, cwd)) : void 0;
          row = this._rowFromSummary(definition, sc, true, ws);
          if (!row.name) row.name = skillName;
        }
      }
    }
    if (!row) throw new Error('skill "' + skillName + '" not found' + (source ? ' in source "' + source + '"' : ''));
    if (body === void 0) {
      if (!row.path) throw new Error('skill "' + skillName + '" has no readable body');
      const raw = await readOrNull(row.path);
      if (raw === null) throw new Error('skill "' + skillName + '" not found at ' + row.path);
      const parsed = parseSkillFile(raw);
      if (!parsed.ok) throw new Error('skill "' + skillName + '" has ' + parsed.reason);
      body = parsed.body;
      if (!row.description && typeof parsed.meta.description === 'string') row.description = parsed.meta.description;
    }
    return { ...row, body };
  }

  async create(scope, opts) {
    const o = opts || {};
    const sc = this.normalizeScope(scope);
    const skillName = o.name;
    if (typeof skillName !== 'string' || !SKILL_NAME.test(skillName)) {
      throw new Error('invalid skill name "' + skillName + '" - use kebab-case (a-z, 0-9, hyphen)');
    }
    const description = o.description === undefined || o.description === null ? '' : String(o.description).trim();
    if (!description) throw new Error('a description is required for skill "' + skillName + '"');
    const root = await this._managedRoot(sc, o.source, o.workspacePath);
    if (await locate(root.path, skillName)) throw new Error('skill "' + skillName + '" already exists in ' + root.path);
    const lines = [];
    fmSet(lines, 'name', skillName);
    fmSet(lines, 'description', description);
    if (o.whenToUse) fmSet(lines, 'whenToUse', String(o.whenToUse));
    if (o.modelInvocable === false) fmSet(lines, 'disable-model-invocation', true);
    if (o.userInvocable === false) fmSet(lines, 'user-invocable', false);
    const dir = join(root.path, skillName);
    await mkdir(dir, { recursive: true });
    const skillPath = join(dir, 'SKILL.md');
    await writeFile(skillPath, serializeSkillFile(lines, o.content || ''), 'utf8');
    return { name: skillName, path: skillPath, scope: root.scope, source: root.source };
  }

  async update(scope, skillName, patch, source, workspacePath) {
    const sc = this.normalizeScope(scope);
    if (!SKILL_NAME.test(skillName)) throw new Error('invalid skill name: ' + skillName);
    const p = patch || {};
    if (p.description !== undefined && !String(p.description).trim()) {
      throw new Error('a description is required for skill "' + skillName + '"');
    }
    const root = await this._managedRoot(sc, source, workspacePath);
    const loc = await locate(root.path, skillName);
    if (!loc) throw new Error('skill "' + skillName + '" not found under ' + root.path);
    const raw = await readFile(loc.skillPath, 'utf8');
    const parsed = parseSkillFile(raw);
    if (!parsed.ok) throw new Error('skill "' + skillName + '" has ' + parsed.reason);
    const lines = parsed.lines;
    if (p.description !== undefined) fmSet(lines, 'description', String(p.description));
    if (p.whenToUse !== undefined) fmSet(lines, 'whenToUse', String(p.whenToUse));
    if (p.modelInvocable === false) fmSet(lines, 'disable-model-invocation', true);
    else if (p.modelInvocable === true) fmSet(lines, 'disable-model-invocation', undefined);
    if (p.userInvocable === false) fmSet(lines, 'user-invocable', false);
    else if (p.userInvocable === true) fmSet(lines, 'user-invocable', undefined);
    const body = p.content !== undefined ? p.content : parsed.body;
    await writeFile(loc.skillPath, serializeSkillFile(lines, body), 'utf8');
    return { name: skillName, path: loc.skillPath, scope: root.scope, source: root.source };
  }

  async setEnabled(scope, skillName, enabled, source, workspacePath) {
    const sc = this.normalizeScope(scope);
    if (!SKILL_NAME.test(skillName)) throw new Error('invalid skill name: ' + skillName);
    const root = await this._managedRoot(sc, source, workspacePath);
    const loc = await locate(root.path, skillName);
    if (!loc) throw new Error('skill "' + skillName + '" not found under ' + root.path);
    const raw = await readFile(loc.skillPath, 'utf8');
    const parsed = parseSkillFile(raw);
    if (!parsed.ok) throw new Error('skill "' + skillName + '" has ' + parsed.reason);
    const lines = parsed.lines;
    // ONLY the model-invocation flag: `user-invocable` is deliberately untouched.
    fmSet(lines, 'disable-model-invocation', enabled ? undefined : true);
    await writeFile(loc.skillPath, serializeSkillFile(lines, parsed.body), 'utf8');
    return { name: skillName, enabled: enabled === true, path: loc.skillPath, scope: root.scope, source: root.source };
  }

  async remove(scope, skillName, source, workspacePath) {
    const sc = this.normalizeScope(scope);
    if (!SKILL_NAME.test(skillName)) throw new Error('invalid skill name: ' + skillName);
    const root = await this._managedRoot(sc, source, workspacePath);
    const loc = await locate(root.path, skillName);
    if (!loc) throw new Error('skill "' + skillName + '" not found under ' + root.path);
    const target = loc.kind === 'dir' ? loc.dir : loc.skillPath;
    await rm(target, { recursive: true, force: true });
    return { name: skillName, removed: true, scope: root.scope, source: root.source };
  }
}

// Remote method markers: the Typert Gateway's SRC route resolves these claims
// without generated typert metadata. Wire parameter names are derived from the
// method signatures above, so they must stay simple identifiers (no
// destructuring, defaults, or rest parameters).
Object.defineProperty(SkillManagerService.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      'getInfo',
      'list',
      'read',
      'create',
      'update',
      'setEnabled',
      'remove',
    ].map((method) => Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) }))),
  }),
});

function tokenize(input) {
  const tokens = [];
  const re = /[^\s"]+|"([^"]*)"/g;
  let m;
  while ((m = re.exec(input)) !== null) tokens.push(m[1] ?? m[0]);
  return tokens;
}

function parseFlags(tokens) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('--') && i + 1 < tokens.length) { flags[t.slice(2)] = tokens[++i]; }
    else positional.push(t);
  }
  return { flags, positional };
}

function scopeOf(flags) {
  const s = flags.scope;
  if (s === undefined || s === '') return 'personal';
  return s;
}

/** `--workspace <path>` selects one project when several are registered. */
function workspaceOf(flags) {
  const w = flags.workspace;
  return typeof w === 'string' && w.trim() !== '' ? w : undefined;
}

function renderList(doc) {
  if (doc.length === 0) return { kind: 'success', text: 'No skills found in the selected scope.' };
  const lines = doc.map((s) => {
    const inv = (s.modelInvocable ? 'm' : '-m') + '/' + (s.userInvocable ? 'u' : '-u');
    const state = s.enabled ? 'enabled' : 'disabled';
    const flags = [];
    if (s.readOnly) flags.push('read-only');
    if (s.shadowed) flags.push('shadowed');
    if (s.complete === false) flags.push('incomplete');
    const where = s.workspaceTitle ? ' @ ' + s.workspaceTitle : '';
    return '  \u2022 ' + s.name + where + '  [' + s.source + ' \u00b7 ' + state + ' \u00b7 ' + inv
      + (flags.length ? ' \u00b7 ' + flags.join(', ') : '') + ']  - ' + s.description;
  });
  return { kind: 'success', text: 'Skills (' + doc.length + '):\n' + lines.join('\n') };
}

function renderSkill(entry) {
  const inv = entry.modelInvocable && entry.userInvocable ? 'enabled' : 'disabled';
  const head = [];
  head.push('# ' + entry.name + '  [' + inv + ']');
  if (entry.description) head.push(entry.description);
  if (entry.whenToUse) head.push('Use when: ' + entry.whenToUse);
  head.push('Scope: ' + entry.scope + ' \u00b7 Source: ' + entry.source + (entry.workspaceTitle ? ' \u00b7 Workspace: ' + entry.workspaceTitle : ''));
  if (entry.readOnly) head.push('Read-only: yes');
  head.push('Path: ' + entry.path);
  if (!(entry.modelInvocable && entry.userInvocable)) head.push('Model: ' + (entry.modelInvocable ? 'on' : 'off') + ' \u00b7 User: ' + (entry.userInvocable ? 'on' : 'off'));
  return { kind: 'success', text: head.join('\n') + '\n\n' + (entry.body || '(empty body)') };
}

function apply(ctx, config = {}) {
  const manager = new SkillManagerService(ctx, config);
  // Provided as a Cordis service: the Typert Gateway discovers it through
  // reflect.props + the typertRemote binding, so this package's Client half
  // (and any owner peer) can call `skillManager/<method>` over `/api` RPC.
  ctx.provide(SERVICE_KEY, manager);

  const P = '@zhougui/skill-manager';
  const USAGE =
    'Usage:\n' +
    '  /skill list [--scope <personal|project>]\n' +
    '  /skill view <name> [--scope <personal|project>] [--source ...] [--workspace <path>]\n' +
    '  /skill create <name> --description "..." [--content "..."] [--when "..."] [--no-model|--no-user] [--scope ...] [--source <user-dsh|user-agents|project-dsh|project-agents>] [--workspace <path>]\n' +
    '  /skill edit <name> [--description "..."] [--content "..."] [--when "..."] [--no-model|--model] [--no-user|--user] [--scope ...] [--workspace <path>]\n' +
    '  /skill enable <name> [--scope ...] [--workspace <path>]\n' +
    '  /skill disable <name> [--scope ...] [--workspace <path>]\n' +
    '  /skill delete <name> [--scope ...] [--workspace <path>]';
  const wrap = (fn) => async (invocation) => {
    try { return await fn(invocation); } catch (error) { return { kind: 'error', text: String(error && error.message ? error.message : error) }; }
  };

  ctx.commands.register({ definitionId: CommandDefinitionId(P + '/list'), name: 'skill-list', description: 'List managed skills with availability', input: { hint: '[--scope personal|project]' }, handler: wrap(async (inv) => { const r = parseFlags(tokenize(inv.rawInput)); return renderList(await manager.list(scopeOf(r.flags))); }) });
  ctx.commands.register({ definitionId: CommandDefinitionId(P + '/view'), name: 'skill-view', description: 'Show one skill (frontmatter + body)', input: { hint: '<name> [--scope ...] [--source ...]' }, handler: wrap(async (inv) => { const r = parseFlags(tokenize(inv.rawInput)); const n = r.positional[0]; if (!n) return { kind: 'error', text: 'A skill name is required.\n' + USAGE }; return renderSkill(await manager.read(scopeOf(r.flags), n, r.flags.source, workspaceOf(r.flags))); }) });
  ctx.commands.register({ definitionId: CommandDefinitionId(P + '/create'), name: 'skill-create', description: 'Create a new skill (writes <root>/<name>/SKILL.md)', input: { hint: '<name> --description "..." [...]' }, handler: wrap(async (inv) => { const r0 = parseFlags(tokenize(inv.rawInput)); const n = r0.positional[0]; const sc = scopeOf(r0.flags); if (!n) return { kind: 'error', text: 'A skill name is required (kebab-case).\n' + USAGE }; if (!r0.flags.description) return { kind: 'error', text: '--description is required.\n' + USAGE }; const r = await manager.create(sc, { name: n, description: r0.flags.description, content: r0.flags.content || '', whenToUse: r0.flags.when, source: r0.flags.source, modelInvocable: r0.flags['no-model'] === void 0, userInvocable: r0.flags['no-user'] === void 0, workspacePath: workspaceOf(r0.flags) }); return { kind: 'success', text: 'Created skill "' + r.name + '" at ' + r.path + ('. scope=' + sc + ' source=' + r.source) + '.' }; }) });
  ctx.commands.register({ definitionId: CommandDefinitionId(P + '/edit'), name: 'skill-edit', description: 'Edit a skill frontmatter and/or body', input: { hint: '<name> [--description ...] [--content ...] [--when ...]' }, handler: wrap(async (inv) => { const r0 = parseFlags(tokenize(inv.rawInput)); const n = r0.positional[0]; const sc = scopeOf(r0.flags); if (!n) return { kind: 'error', text: 'A skill name is required.\n' + USAGE }; const patch = {}; if (r0.flags.description !== void 0) patch.description = r0.flags.description; if (r0.flags.content !== void 0) patch.content = r0.flags.content; if (r0.flags.when !== void 0) patch.whenToUse = r0.flags.when; if (r0.flags['no-model'] !== void 0) patch.modelInvocable = false; if (r0.flags.model !== void 0) patch.modelInvocable = true; if (r0.flags['no-user'] !== void 0) patch.userInvocable = false; if (r0.flags.user !== void 0) patch.userInvocable = true; if (Object.keys(patch).length === 0) return { kind: 'error', text: 'Nothing to change. Provide at least one --flag.\n' + USAGE }; const r = await manager.update(sc, n, patch, r0.flags.source, workspaceOf(r0.flags)); return { kind: 'success', text: 'Updated skill "' + r.name + '" at ' + r.path + '.' }; }) });
  ctx.commands.register({ definitionId: CommandDefinitionId(P + '/enable'), name: 'skill-enable', description: 'Enable a skill (model invocation on; user invocation untouched)', input: { hint: '<name> [--scope ...]' }, handler: wrap(async (inv) => { const r = parseFlags(tokenize(inv.rawInput)); const n = r.positional[0]; if (!n) return { kind: 'error', text: 'A skill name is required.\n' + USAGE }; const s = await manager.setEnabled(scopeOf(r.flags), n, true, r.flags.source, workspaceOf(r.flags)); return { kind: 'success', text: 'Enabled skill "' + s.name + '".' }; }) });
  ctx.commands.register({ definitionId: CommandDefinitionId(P + '/disable'), name: 'skill-disable', description: 'Disable a skill (model invocation off; user invocation untouched)', input: { hint: '<name> [--scope ...]' }, handler: wrap(async (inv) => { const r = parseFlags(tokenize(inv.rawInput)); const n = r.positional[0]; if (!n) return { kind: 'error', text: 'A skill name is required.\n' + USAGE }; const s = await manager.setEnabled(scopeOf(r.flags), n, false, r.flags.source, workspaceOf(r.flags)); return { kind: 'success', text: 'Disabled skill "' + s.name + '".' }; }) });
  ctx.commands.register({ definitionId: CommandDefinitionId(P + '/delete'), name: 'skill-delete', description: 'Delete a skill (removes its directory / SKILL.md)', input: { hint: '<name> [--scope ...]' }, handler: wrap(async (inv) => { const r = parseFlags(tokenize(inv.rawInput)); const n = r.positional[0]; if (!n) return { kind: 'error', text: 'A skill name is required.\n' + USAGE }; const s = await manager.remove(scopeOf(r.flags), n, r.flags.source, workspaceOf(r.flags)); return { kind: 'success', text: 'Deleted skill "' + s.name + '".' }; }) });
  if (ctx.logger && typeof ctx.logger.info === 'function') ctx.logger.info('skill-manager ready: personal=' + manager.personalRoot + (manager.projectRoot ? ' project=' + manager.projectRoot : ''));
}

export { apply, inject, name };