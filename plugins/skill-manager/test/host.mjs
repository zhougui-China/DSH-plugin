// Local smoke test for the Host half. Run from the workspace root:
//   node skill-manager/test/host.mjs
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { apply, inject } from '../lib/index.js';

let failed = 0;
const check = (label, ok, extra) => {
  if (!ok) failed++;
  console.log((ok ? 'ok  ' : 'FAIL') + '  ' + label + (ok ? '' : '  ' + String(extra ?? '')));
};

/** Call and return the thrown message, or null when it resolved. */
const refusal = async (fn) => {
  try { await fn(); return null; } catch (error) { return error && error.message ? error.message : String(error); }
};

const fakeCtx = (get) => {
  const provided = {};
  const registrations = [];
  const ctx = {
    provide: (k, v) => { provided[k] = v; },
    get,
    effect: () => {},
    commands: { register: (r) => registrations.push(r) },
    logger: null,
  };
  return { ctx, provided, registrations };
};

/** Write `<root>/<skillName>/SKILL.md`; `lines` are extra frontmatter lines. */
async function writeSkill(root, skillName, lines = [], body = 'Body.') {
  const dir = join(root, skillName);
  await mkdir(dir, { recursive: true });
  const text = ['---', 'name: ' + skillName, 'description: Description of ' + skillName, ...lines, '---', '', body, ''].join('\n');
  const p = join(dir, 'SKILL.md');
  await writeFile(p, text, 'utf8');
  return p;
}

/** Write a SKILL.md at an explicit path (for dot-directory cases). */
async function writeSkillAt(skillPath, skillName, body = 'Body.') {
  await mkdir(dirname(skillPath), { recursive: true });
  await writeFile(skillPath, ['---', 'name: ' + skillName, 'description: Description of ' + skillName, '---', '', body, ''].join('\n'), 'utf8');
  return skillPath;
}

const base = await mkdtemp(join(tmpdir(), 'skill-manager-test-'));

// =====================================================================
// A. Filesystem fallback (no optional services) + explicit project config
// =====================================================================
const personalRoot = join(base, 'personal', 'skills');
const projectRoot = join(base, 'project', '.dsh', 'skills');
const personalAgents = join(base, 'agents', 'skills');
const projectBase = join(base, 'project');
await mkdir(personalRoot, { recursive: true });
await mkdir(projectRoot, { recursive: true });

const a = fakeCtx(() => null);
apply(a.ctx, { personalRoot, projectRoot, personalAgentsRoot: personalAgents });
const m = a.provided.skillManager;

check('apply provides skillManager', !!m);
check('7 commands registered', a.registrations.length === 7, a.registrations.length);
check('inject keeps commands + skills', JSON.stringify(inject) === '["commands","skills"]', JSON.stringify(inject));

// ---- information & root shape ----
const info = await m.getInfo();
check('getInfo exposes scopes + personalRoots',
  info.scopes.includes('personal') && info.scopes.includes('project') && Array.isArray(info.personalRoots),
  JSON.stringify(info));
check('legacy roots cover all four managed sources',
  JSON.stringify(info.roots.map((r) => r.source).sort()) === JSON.stringify(['project-agents', 'project-dsh', 'user-agents', 'user-dsh']),
  info.roots.map((r) => r.source).join(','));
check('primary personal root honoured', m.personalRoot === personalRoot, m.personalRoot + ' vs ' + personalRoot);
check('primary project root honoured', m.projectRoot === projectRoot, m.projectRoot + ' vs ' + projectRoot);
check('skillsService false without the service', info.skillsService === false, String(info.skillsService));
check('readOnlySources lists custom/bundled/runtime',
  JSON.stringify(info.readOnlySources) === JSON.stringify(['custom', 'bundled', 'runtime']), JSON.stringify(info.readOnlySources));
check('config echo', info.config.personalRoot === personalRoot && info.config.includeAgentsRoots === true, JSON.stringify(info.config));

// ---- canonical project-agents path (finding 2) ----
check('explicit project listed as one workspace', info.workspaces.length === 1, JSON.stringify(info.workspaces));
const wsA = info.workspaces[0];
const wsADsh = wsA.roots.find((r) => r.source === 'project-dsh');
const wsAAgents = wsA.roots.find((r) => r.source === 'project-agents');
check('canonical project-agents is <P>/.agents/skills',
  wsAAgents.path === join(projectBase, '.agents', 'skills') && !wsAAgents.path.includes(join('.dsh', '.agents')),
  wsAAgents.path);
check('workspace roots[].exists reflects reality', wsADsh.exists === true && wsAAgents.exists === false, JSON.stringify(wsA.roots));

// ---- create ----
const c = await m.create('personal', { name: 'demo-skill', description: 'A demo: skill with spaces', content: 'Body line.' });
check('create returns path under personal user-dsh', c.name === 'demo-skill' && c.source === 'user-dsh' && c.path.startsWith(personalRoot), JSON.stringify(c));
const cp = await m.create('project', { name: 'proj-skill', description: 'Project skill', content: 'Project body.', source: 'project-dsh' });
check('create into project-dsh', cp.path.startsWith(projectRoot), JSON.stringify(cp));
const cpa = await m.create('project', { name: 'agents-skill', description: 'Agents skill', source: 'project-agents' });
check('project-agents create lands in <P>/.agents/skills',
  cpa.path.startsWith(join(projectBase, '.agents', 'skills')) && !cpa.path.includes(join('.dsh', '.agents')), cpa.path);

// ---- list personal ----
const lp = await m.list('personal');
const demo = lp.find((r) => r.name === 'demo-skill');
check('personal list carries the new row shape',
  lp.length === 1 && demo && demo.scope === 'personal' && demo.source === 'user-dsh'
  && demo.rank === 400 && demo.shadowed === false && demo.readOnly === false
  && demo.complete === true && demo.kind === 'dir',
  JSON.stringify(lp));

// ---- list project (multi-row, one project) ----
const lj = await m.list('project');
check('project list has both project rows', lj.length === 2 && lj.some((r) => r.name === 'proj-skill') && lj.some((r) => r.name === 'agents-skill'),
  JSON.stringify(lj.map((r) => r.name)));
check('project rows carry workspace identity + are writable',
  lj.every((r) => r.workspacePath === projectBase && r.workspaceTitle === 'project' && r.readOnly === false),
  JSON.stringify(lj));

// ---- read ----
const r = await m.read('personal', 'demo-skill');
check('read parses description/body', r.description === 'A demo: skill with spaces' && r.body === 'Body line.' && r.scope === 'personal', JSON.stringify(r));
const rp = await m.read('project', 'proj-skill', 'project-dsh');
check('read project skill via source', rp.name === 'proj-skill' && rp.body === 'Project body.', JSON.stringify(rp));

// ---- default/unknown scope resolution ----
check('list() defaults to personal', (await m.list()).some((s) => s.name === 'demo-skill'));
check('unknown scope rejected', (await refusal(() => m.list('bogus'))) !== null);

// ---- file shape ----
const raw1 = await readFile(c.path, 'utf8');
check('file has frontmatter delimiters', raw1.startsWith('---\n') && raw1.includes('\n---\n\n'), JSON.stringify(raw1));

// ---- setEnabled toggles ONLY disable-model-invocation (finding 8) ----
await m.setEnabled('personal', 'demo-skill', false);
const r2 = await m.read('personal', 'demo-skill');
check('disable turns model invocation off, user invocation untouched',
  r2.modelInvocable === false && r2.userInvocable === true && r2.enabled === false, JSON.stringify(r2));
const rawDisabled = await readFile(c.path, 'utf8');
check('disable never writes user-invocable', !rawDisabled.includes('user-invocable'), JSON.stringify(rawDisabled));
await m.setEnabled('personal', 'demo-skill', true);
const r3 = await m.read('personal', 'demo-skill');
check('enable turns model invocation back on', r3.modelInvocable === true && r3.userInvocable === true && r3.enabled === true, JSON.stringify(r3));

// a skill that is user-invocation-off must keep that flag through both toggles
const cu = await m.create('personal', { name: 'user-off', description: 'user invocation off', userInvocable: false });
await m.setEnabled('personal', 'user-off', true);
const ru = await m.read('personal', 'user-off');
check('enable does not clear an explicit user-invocable:false', ru.userInvocable === false && ru.modelInvocable === true, JSON.stringify(ru));
await m.setEnabled('personal', 'user-off', false);
const ru2 = await m.read('personal', 'user-off');
check('user-invocable survives a full off/on/off cycle', ru2.userInvocable === false && ru2.modelInvocable === false, JSON.stringify(ru2));
check('user-invocable:false still present on disk', (await readFile(cu.path, 'utf8')).includes('user-invocable: false'));

// ---- update ----
await m.update('personal', 'demo-skill', { description: 'New "quoted" description', content: 'New body.' });
const r4 = await m.read('personal', 'demo-skill');
check('update rewrites description/body', r4.description === 'New "quoted" description' && r4.body === 'New body.', JSON.stringify(r4));

// ---- complex frontmatter preservation ----
await mkdir(join(personalRoot, 'complex-skill'), { recursive: true });
await writeFile(join(personalRoot, 'complex-skill', 'SKILL.md'),
  '---\n' +
  'name: complex-skill\n' +
  '# a comment line\n' +
  'description: "Quoted: description"\n' +
  'author: someone\n' +
  'tags:\n' +
  '  - alpha\n' +
  '  - beta\n' +
  'notes: |\n' +
  '  keep\n' +
  '  me\n' +
  'allowed-tools: ["Bash", "Read"]\n' +
  '---\n\n' +
  'Complex body.\n', 'utf8');
await m.update('personal', 'complex-skill', { description: 'Updated plain description' });
const raw2 = await readFile(join(personalRoot, 'complex-skill', 'SKILL.md'), 'utf8');
const kept =
  raw2.includes('# a comment line') &&
  raw2.includes('author: someone') &&
  raw2.includes('- alpha') && raw2.includes('- beta') &&
  raw2.includes('notes: |') && raw2.includes('keep') && raw2.includes('me') &&
  raw2.includes('allowed-tools: ["Bash", "Read"]') &&
  raw2.includes('description: Updated plain description') &&
  raw2.includes('Complex body.');
check('unknown frontmatter lines preserved', kept, JSON.stringify(raw2));

// ---- validation (finding 7) ----
check('invalid skill name rejected on create',
  /invalid skill name/.test(await refusal(() => m.create('personal', { name: 'Bad Name', description: 'x' })) || ''));
check('empty description rejected on create',
  /description is required/.test(await refusal(() => m.create('personal', { name: 'ok-name', description: '   ' })) || ''));
check('empty description rejected on update',
  /description is required/.test(await refusal(() => m.update('personal', 'demo-skill', { description: '  ' })) || ''));
check('empty description rejected on project create',
  /description is required/.test(await refusal(() => m.create('project', { name: 'ok-name', description: '' })) || ''));

// ---- read-only refusal (findings 6/9) ----
const refuseCreate = await refusal(() => m.create('personal', { name: 'nope', description: 'x', source: 'bundled' }));
check('create refuses bundled with a read-only error', /is read-only/.test(refuseCreate || ''), refuseCreate);
const refuseUpdate = await refusal(() => m.update('personal', 'demo-skill', { description: 'x' }, 'custom'));
check('update refuses custom', /is read-only/.test(refuseUpdate || ''), refuseUpdate);
const refuseEnable = await refusal(() => m.setEnabled('personal', 'demo-skill', false, 'runtime'));
check('setEnabled refuses runtime', /is read-only/.test(refuseEnable || ''), refuseEnable);
const refuseRemove = await refusal(() => m.remove('personal', 'demo-skill', 'bundled'));
check('remove refuses bundled', /is read-only/.test(refuseRemove || ''), refuseRemove);
check('refused remove left the skill in place', (await m.list('personal')).some((s) => s.name === 'demo-skill'));
const refuseUnknownWs = await refusal(() => m.create('project', { name: 'nope', description: 'x', workspacePath: join(base, 'no-such-workspace') }));
check('project mutation refuses an unknown workspacePath', /unknown workspace/.test(refuseUnknownWs || ''), refuseUnknownWs);
const enabledRefused = await refusal(() => m.update('project', 'nope-name', { description: 'x' }));
check('unmanaged source name is never silently accepted', enabledRefused !== null, enabledRefused);

// ---- `.system` skip only where the provider skips it (finding 5) ----
// The skip only matters when `.system` itself is a skill directory, i.e. it
// directly contains a SKILL.md.
await writeSkillAt(join(personalRoot, '.system', 'SKILL.md'), 'sys-skill', 'system personal');
await writeSkillAt(join(projectRoot, '.system', 'SKILL.md'), 'proj-sys', 'system project');
check('.system skipped under user-dsh', !(await m.list('personal')).some((s) => s.name === 'sys-skill'));
check('.system NOT skipped under project roots', (await m.list('project')).some((s) => s.name === 'proj-sys'));

// ---- SRC route shape ----
check('typertRemote binding on instance',
  m.typertRemote && m.typertRemote.service === m && m.typertRemote.serviceKey === 'skillManager' && m.typertRemote.namespace === 'skillManager',
  'ns=' + m.typertRemote?.namespace);
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';
const proto = Object.getPrototypeOf(m);
const markerDesc = proto[REMOTE_METHOD_DESCRIPTOR];
check('remote-methods descriptor on prototype', markerDesc && markerDesc.version === 1 && Array.isArray(markerDesc.methods), JSON.stringify(markerDesc));
const marked = new Set((markerDesc?.methods ?? []).map((k) => k.method));
check('same seven methods marked remote',
  JSON.stringify([...marked].sort()) === JSON.stringify(['create', 'getInfo', 'list', 'read', 'remove', 'setEnabled', 'update'].sort()),
  [...marked].join(','));
const paramNames = (method) => {
  const impl = Object.getOwnPropertyDescriptor(proto, method).value;
  const src = Function.prototype.toString.call(impl);
  const open = src.indexOf('('); const close = src.indexOf(')', open + 1);
  const bodyTxt = src.slice(open + 1, close).trim();
  return bodyTxt.length === 0 ? [] : bodyTxt.split(',').map((p) => p.trim());
};
check('wire signatures keep simple identifiers + trailing workspacePath',
  JSON.stringify(paramNames('list')) === '["scope"]' &&
  JSON.stringify(paramNames('getInfo')) === '[]' &&
  JSON.stringify(paramNames('read')) === '["scope","skillName","source","workspacePath"]' &&
  JSON.stringify(paramNames('create')) === '["scope","opts"]' &&
  JSON.stringify(paramNames('update')) === '["scope","skillName","patch","source","workspacePath"]' &&
  JSON.stringify(paramNames('setEnabled')) === '["scope","skillName","enabled","source","workspacePath"]' &&
  JSON.stringify(paramNames('remove')) === '["scope","skillName","source","workspacePath"]',
  ['list', 'read', 'create', 'update', 'setEnabled', 'remove', 'getInfo'].map(paramNames).map(JSON.stringify).join(' '));

const jsonSafe = (v) => { try { JSON.stringify(v); return true; } catch { return false; } };
const info2 = await m.getInfo();
const lst = await m.list('personal');
const one = await m.read('personal', 'complex-skill');
check('results JSON-safe', jsonSafe(info2) && jsonSafe(lst) && jsonSafe(one), JSON.stringify(info2));

// ---- remove ----
const d = await m.remove('personal', 'demo-skill');
check('remove reports removed', d.removed === true && d.scope === 'personal', JSON.stringify(d));
await m.remove('personal', 'complex-skill');
await m.remove('project', 'proj-skill', 'project-dsh');
const afterRemove = await m.list('personal');
check('removed skills are gone', !afterRemove.some((s) => s.name === 'demo-skill') && !afterRemove.some((s) => s.name === 'complex-skill'),
  JSON.stringify(afterRemove.map((s) => s.name)));
check('project removal only removed the requested skill',
  !(await m.list('project')).some((s) => s.name === 'proj-skill') && (await m.list('project')).some((s) => s.name === 'agents-skill'));

// =====================================================================
// B. Multi-project enumeration through a fake workspaceRegistry (finding 1)
// =====================================================================
const multiBase = join(base, 'multi');
const wsOne = join(multiBase, 'project-a');
const wsTwo = join(multiBase, 'project-b');
const wsGone = join(multiBase, 'gone');
await writeSkill(join(wsOne, '.dsh', 'skills'), 'a-skill', [], 'A body.');
await writeSkill(join(wsOne, '.agents', 'skills'), 'shared-skill', [], 'agent A body.');
await writeSkill(join(wsOne, '.dsh', 'skills'), 'dup-skill', [], 'dsh dup.');
await writeSkill(join(wsOne, '.agents', 'skills'), 'dup-skill', [], 'agents dup.');
await writeSkill(join(wsTwo, '.dsh', 'skills'), 'b-skill', [], 'B body.');
await mkdir(wsGone, { recursive: true });

const registry = {
  list: () => [
    { id: 'a', title: 'Project A', path: wsOne, status: () => 'ok' },
    { id: 'b', title: 'Project B', path: wsTwo, status: () => 'ok' },
    { id: 'c', title: 'Missing One', path: wsGone, status: () => 'missing-dir' },
  ],
};
const b = fakeCtx((k) => (k === 'workspaceRegistry' ? registry : null));
apply(b.ctx, { personalRoot: join(multiBase, 'personal', 'skills'), personalAgentsRoot: join(multiBase, 'personal-agents', 'skills') });
const mB = b.provided.skillManager;

const infoB = await mB.getInfo();
check('multi-project: every registry workspace listed with its status',
  infoB.workspaces.length === 3 && infoB.workspaces.map((w) => w.id).join(',') === 'a,b,c'
  && infoB.workspaces[2].status === 'missing-dir',
  JSON.stringify(infoB.workspaces.map((w) => [w.id, w.status])));
const aAgents = infoB.workspaces[0].roots.find((r) => r.source === 'project-agents');
check('canonical project-agents root per workspace',
  aAgents.path === join(wsOne, '.agents', 'skills') && !aAgents.path.includes(join('.dsh', '.agents')), aAgents.path);
check('roots[].exists reflects reality per workspace',
  infoB.workspaces[0].roots.every((r) => r.exists === true)
  && infoB.workspaces[1].roots.find((r) => r.source === 'project-agents').exists === false,
  JSON.stringify(infoB.workspaces.map((w) => w.roots)));
check('skillsService false in fallback multi-project mode', infoB.skillsService === false);

const ljB = await mB.list('project');
check('rows from every live project are listed',
  ljB.some((r) => r.name === 'a-skill' && r.workspaceId === 'a' && r.workspacePath === wsOne)
  && ljB.some((r) => r.name === 'b-skill' && r.workspaceId === 'b' && r.workspacePath === wsTwo),
  JSON.stringify(ljB.map((r) => [r.name, r.workspaceId])));
check('missing-dir workspace contributes no rows', !ljB.some((r) => r.workspaceId === 'c'));
check('project sort: workspace title, then rank, then name',
  ljB[0].workspaceTitle === 'Project A' && JSON.stringify(ljB.map((r) => r.name)).startsWith('["a-skill","dup-skill"'),
  JSON.stringify(ljB.map((r) => [r.workspaceTitle, r.rank, r.name])));
const dupRows = ljB.filter((r) => r.name === 'dup-skill');
check('same-name collision lists both rows', dupRows.length === 2, JSON.stringify(dupRows.map((r) => [r.source, r.shadowed])));
check('lower-rank project-dsh wins, project-agents shadowed',
  dupRows.find((r) => r.source === 'project-dsh').shadowed === false
  && dupRows.find((r) => r.source === 'project-agents').shadowed === true,
  JSON.stringify(dupRows.map((r) => [r.source, r.rank, r.shadowed])));
check('project rows are writable + complete in fallback', ljB.every((r) => r.readOnly === false && r.complete === true));
check('a different-named agents skill is not shadowed',
  ljB.find((r) => r.name === 'shared-skill').shadowed === false && ljB.find((r) => r.name === 'shared-skill').source === 'project-agents');

// targeted mutation picks the requested workspace
const createdB = await mB.create('project', { name: 'new-a', description: 'new a', source: 'project-dsh', workspacePath: wsOne });
check('create targets the supplied workspacePath', createdB.path.startsWith(join(wsOne, '.dsh', 'skills')), createdB.path);
const agentsB = await mB.create('project', { name: 'new-agents', description: 'new agents', source: 'project-agents', workspacePath: wsTwo });
check('project-agents create uses the canonical base of the supplied workspace',
  agentsB.path.startsWith(join(wsTwo, '.agents', 'skills')) && !agentsB.path.includes(join('.dsh', '.agents')), agentsB.path);
check('unmanaged project source refused even with a valid workspace',
  /is read-only/.test(await refusal(() => mB.create('project', { name: 'x', description: 'x', source: 'bundled', workspacePath: wsOne })) || ''));

// =====================================================================
// C. Discovery through a fake skills service (read-only sources, complete)
// =====================================================================
const svcBase = join(base, 'service');
const svcPersonal = join(svcBase, 'personal', 'skills');
const svcWorkspace = join(svcBase, 'workspace');
// A custom provider root is a DIFFERENT directory from the personal root: one
// skill file must never be reachable from two roots, or the union would
// legitimately list it twice.
const svcCustom = join(svcBase, 'custom', 'skills');
await mkdir(svcPersonal, { recursive: true });
await mkdir(svcWorkspace, { recursive: true });
await mkdir(svcCustom, { recursive: true });
const customPath = await writeSkill(svcCustom, 'custom-tool', [], 'Custom body.');
await writeSkill(svcPersonal, 'demo', [], 'Demo body.');
const snapshotCalls = [];
const skillsSvc = {
  async snapshot(opts = {}) {
    snapshotCalls.push(opts.cwd ?? null);
    if (!opts.cwd) {
      return {
        complete: true,
        skills: [
          { name: 'demo', description: 'user demo', source: 'user-dsh', path: join(svcPersonal, 'demo', 'SKILL.md'), invocation: { modelInvocable: true, userInvocable: true } },
          { name: 'demo', description: 'bundled demo', source: 'bundled', invocation: { modelInvocable: true, userInvocable: true } },
          { name: 'custom-tool', description: 'custom', source: 'custom', path: customPath, invocation: { modelInvocable: true, userInvocable: true } },
        ],
      };
    }
    return {
      complete: false,
      skills: [
        { name: 'proj-svc', description: 'svc project', source: 'project-dsh', path: join(opts.cwd, '.dsh', 'skills', 'proj-svc', 'SKILL.md'), invocation: { modelInvocable: false, userInvocable: true } },
        { name: 'user-noise', description: 'noise', source: 'user-dsh', invocation: { modelInvocable: true, userInvocable: true } },
      ],
    };
  },
  // No service body: read() must fall back to the row path.
  async get() { return undefined; },
};
const svcRegistry = { list: () => [{ id: 'w', title: 'Work', path: svcWorkspace, status: () => 'ok' }] };
const cCtx = fakeCtx((k) => (k === 'skills' ? skillsSvc : (k === 'workspaceRegistry' ? svcRegistry : null)));
apply(cCtx.ctx, { personalRoot: svcPersonal, personalAgentsRoot: join(svcBase, 'agents', 'skills') });
const mC = cCtx.provided.skillManager;

check('skillsService true when the service is present', (await mC.getInfo()).skillsService === true);
const lpC = await mC.list('personal');
check('personal view keeps non-project sources from the snapshot',
  lpC.length === 3 && lpC.map((r) => r.source).sort().join(',') === 'bundled,custom,user-dsh',
  JSON.stringify(lpC.map((r) => r.source)));
check('rows sorted by rank then name',
  lpC.map((r) => r.rank).join(',') === '300,400,600', JSON.stringify(lpC.map((r) => [r.rank, r.name])));
const bundledRow = lpC.find((r) => r.source === 'bundled');
const userDemo = lpC.find((r) => r.source === 'user-dsh' && r.name === 'demo');
const customRow = lpC.find((r) => r.source === 'custom');
check('bundled/custom are listed read-only', bundledRow.readOnly === true && customRow.readOnly === true,
  JSON.stringify([bundledRow.readOnly, customRow.readOnly]));
check('a missing path implies read-only', bundledRow.readOnly === true && bundledRow.path === undefined);
check('shadowed: bundled demo loses to the user-dsh demo',
  userDemo.shadowed === false && bundledRow.shadowed === true,
  JSON.stringify([userDemo.shadowed, bundledRow.shadowed]));
check('shadowed row still listed', lpC.filter((r) => r.name === 'demo').length === 2);
check('snapshot complete=true propagates to personal rows', lpC.every((r) => r.complete === true));

const roRead = await mC.read('personal', 'custom-tool', 'custom');
check('read-only rows still read (read-only only blocks writes)',
  roRead.body === 'Custom body.' && roRead.readOnly === true && roRead.source === 'custom', JSON.stringify(roRead));
check('read prefers the winning row for a shadowed name',
  (await mC.read('personal', 'demo')).source === 'user-dsh');
check('skills-service path still refuses a custom mutation',
  /is read-only/.test(await refusal(() => mC.update('personal', 'custom-tool', { description: 'x' }, 'custom')) || ''));

const ljC = await mC.list('project');
check('project rows attach workspace + complete from the snapshot',
  ljC.length === 1 && ljC[0].name === 'proj-svc' && ljC[0].workspaceId === 'w'
  && ljC[0].workspacePath === svcWorkspace && ljC[0].complete === false
  && ljC[0].modelInvocable === false && ljC[0].userInvocable === true && ljC[0].readOnly === false,
  JSON.stringify(ljC));
check('non-project sources are filtered out of the project view', !ljC.some((r) => r.name === 'user-noise'));
check('project snapshot is requested with the workspace cwd', snapshotCalls.includes(svcWorkspace), JSON.stringify(snapshotCalls));

// =====================================================================
// D. readdir failures are not swallowed as "empty" (finding 4)
// =====================================================================
const readdirBase = join(base, 'readdir');
const goodRoot = join(readdirBase, 'good', 'skills');
await writeSkill(goodRoot, 'good-skill', [], 'good body');

const d1 = fakeCtx(() => null);
apply(d1.ctx, { personalRoot: goodRoot, personalAgentsRoot: join(readdirBase, 'absent', 'skills') });
const lpD = await d1.provided.skillManager.list('personal');
check('a missing optional root is authoritatively empty, not incomplete',
  lpD.length === 1 && lpD[0].name === 'good-skill' && lpD[0].complete === true, JSON.stringify(lpD));

const badRoot = join(readdirBase, 'bad', 'skills');
await mkdir(join(readdirBase, 'bad'), { recursive: true });
await writeFile(badRoot, 'this is a file, not a directory', 'utf8');
const d2 = fakeCtx(() => null);
apply(d2.ctx, { personalRoot: goodRoot, personalAgentsRoot: badRoot });
const mD2 = d2.provided.skillManager;
const lpE = await mD2.list('personal');
check('a failed readdir marks its group incomplete instead of empty',
  lpE.length === 1 && lpE[0].name === 'good-skill' && lpE[0].complete === false, JSON.stringify(lpE));
check('a failed readdir does not throw', Array.isArray(lpE));

// =====================================================================
// F. Regression: the filesystem scan is primary, the snapshot is a union
// =====================================================================
// This plugin is a profile-level (host) row. A skills read with no `scope`
// merges only the GLOBAL layer, while a shipped filesystem provider mounted by
// an agent preset registers into that preset's layer -- so a host-level
// `snapshot()` can observe nothing while the managed directories are full.
// Trusting the snapshot alone made the personal view silently empty.
const xBase = join(base, 'union');
const xPersonal = join(xBase, 'personal', 'skills');
const xAgents = join(xBase, 'agents', 'skills');
const xWs = join(xBase, 'workspace');
await writeSkill(xPersonal, 'disk-skill', [], 'On disk.');
await writeSkill(join(xWs, '.dsh', 'skills'), 'proj-on-disk', [], 'On disk.');
const emptySvc = {
  async snapshot() { return { complete: true, skills: [] }; },
  async get() { return undefined; },
};
const xReg = { list: () => [{ id: 'x', title: 'Union', path: xWs, status: () => 'ok' }] };
const xCtx = fakeCtx((k) => (k === 'skills' ? emptySvc : (k === 'workspaceRegistry' ? xReg : null)));
apply(xCtx.ctx, { personalRoot: xPersonal, personalAgentsRoot: xAgents });
const mX = xCtx.provided.skillManager;
const lpX = await mX.list('personal');
check('an empty snapshot does not hide the personal roots',
  lpX.length === 1 && lpX[0].name === 'disk-skill' && lpX[0].source === 'user-dsh' && lpX[0].complete === true,
  JSON.stringify(lpX));
const ljX = await mX.list('project');
check('an empty snapshot does not hide the project roots',
  ljX.length === 1 && ljX[0].name === 'proj-on-disk' && ljX[0].workspaceId === 'x' && ljX[0].complete === true,
  JSON.stringify(ljX));

const bothSvc = {
  async snapshot(opts = {}) {
    return opts.cwd
      ? { complete: true, skills: [{ name: 'proj-svc2', description: 'svc', source: 'project-dsh', invocation: {} }] }
      : { complete: true, skills: [{ name: 'disk-skill', description: 'svc copy', source: 'user-dsh', invocation: {} }] };
  },
  async get() { return undefined; },
};
const yCtx = fakeCtx((k) => (k === 'skills' ? bothSvc : (k === 'workspaceRegistry' ? xReg : null)));
apply(yCtx.ctx, { personalRoot: xPersonal, personalAgentsRoot: xAgents });
const lpY = await yCtx.provided.skillManager.list('personal');
check('union does not duplicate a skill the snapshot also reports',
  lpY.filter((r) => r.name === 'disk-skill').length === 1, JSON.stringify(lpY.map((r) => [r.source, r.name])));
const ljY = await yCtx.provided.skillManager.list('project');
check('union merges disk and snapshot project rows',
  ljY.map((r) => r.name).sort().join(',') === 'proj-on-disk,proj-svc2', JSON.stringify(ljY.map((r) => r.name)));

// Filesystem rows are collapsed by PHYSICAL FILE, never by name: two distinct
// directories in one root may declare the same name, and a shadowed row must
// still be listed.
const dupRoot = join(base, 'dupname', 'skills');
await writeSkill(dupRoot, 'dup-a', [], 'A body.');
await writeSkillAt(join(dupRoot, 'dup-b', 'SKILL.md'), 'dup-a', 'B body.');
const zCtx = fakeCtx(() => null);
apply(zCtx.ctx, { personalRoot: dupRoot, personalAgentsRoot: join(base, 'dupname', 'agents', 'skills'), includeAgentsRoots: false });
const lpZ = await zCtx.provided.skillManager.list('personal');
check('same declared name in one root keeps both distinct files',
  lpZ.length === 2 && lpZ.every((r) => r.name === 'dup-a') && lpZ.filter((r) => r.shadowed === true).length === 1,
  JSON.stringify(lpZ.map((r) => [r.path, r.shadowed])));

// One physical file reachable from two roots (misconfigured equal roots) is one row.
const wCtx = fakeCtx(() => null);
apply(wCtx.ctx, { personalRoot: dupRoot, personalAgentsRoot: dupRoot });
const lpW = await wCtx.provided.skillManager.list('personal');
check('one directory reachable from two roots is one row per file',
  lpW.length === 2, JSON.stringify(lpW.map((r) => [r.source, r.path])));

// `pathKey` must be physical, not lexical: a junction/symlinked alias of a root
// is the same files, so it must not add rows. Skipped only where links are
// unavailable on the filesystem.
const aliasRoot = join(base, 'dupname', 'alias-root');
let aliasSupported = true;
try { await symlink(dupRoot, aliasRoot, 'junction'); } catch { aliasSupported = false; }
if (aliasSupported) {
  const aCtx = fakeCtx(() => null);
  apply(aCtx.ctx, { personalRoot: dupRoot, personalAgentsRoot: aliasRoot });
  const lpA = await aCtx.provided.skillManager.list('personal');
  check('a junction alias of a root yields one row per physical file',
    lpA.length === 2, JSON.stringify(lpA.map((r) => [r.source, r.path])));
} else {
  console.log('skip  junction alias check (links unsupported on this filesystem)');
}

// Snapshot rows must be deduped against each other as well as against disk.
const dupSvc = {
  async snapshot() {
    return {
      complete: true,
      skills: [
        { name: 'disk-skill', description: 'first', source: 'user-dsh', invocation: {} },
        { name: 'disk-skill', description: 'second', source: 'user-dsh', invocation: {} },
        { name: 'twin', description: 'first', source: 'bundled', invocation: {} },
        { name: 'twin', description: 'second', source: 'bundled', invocation: {} },
      ],
    };
  },
  async get() { return undefined; },
};
const vCtx = fakeCtx((k) => (k === 'skills' ? dupSvc : null));
apply(vCtx.ctx, { personalRoot: xPersonal, personalAgentsRoot: xAgents, includeAgentsRoots: true });
const lpV = await vCtx.provided.skillManager.list('personal');
check('duplicate snapshot rows collapse to one row per source+name',
  lpV.filter((r) => r.name === 'disk-skill').length === 1 && lpV.filter((r) => r.name === 'twin').length === 1,
  JSON.stringify(lpV.map((r) => [r.source, r.name])));

// =====================================================================
// E. Config edges
// =====================================================================
const noConfig = fakeCtx(() => null);
apply(noConfig.ctx, {});
const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME : null;
const expectedDefault = dshHome ? join(dshHome, 'skills') : join(homedir(), '.dsh', 'skills');
check('default personal root resolves dsh home skills',
  noConfig.provided.skillManager.personalRoot === resolve(expectedDefault),
  noConfig.provided.skillManager.personalRoot + ' vs ' + expectedDefault);

const noAgents = fakeCtx(() => null);
apply(noAgents.ctx, { personalRoot, projectRoot, includeAgentsRoots: false });
const infoNoAgents = await noAgents.provided.skillManager.getInfo();
check('includeAgentsRoots:false drops both agents roots',
  infoNoAgents.roots.every((r) => !r.source.endsWith('-agents'))
  && infoNoAgents.workspaces[0].roots.every((r) => r.source !== 'project-agents'),
  JSON.stringify(infoNoAgents.roots));

const noProject = fakeCtx(() => null);
apply(noProject.ctx, { personalRoot, enableProject: false });
const infoNoProject = await noProject.provided.skillManager.getInfo();
check('enableProject:false hides the project scope roots + workspaces',
  infoNoProject.workspaces.length === 0 && infoNoProject.projectRoot === undefined
  && infoNoProject.roots.every((r) => r.scope === 'personal'),
  JSON.stringify(infoNoProject));

await rm(base, { recursive: true, force: true });
console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' FAILURE(S)');
process.exit(failed === 0 ? 0 : 1);
