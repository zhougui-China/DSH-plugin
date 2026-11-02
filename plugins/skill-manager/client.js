window.__ModuleLoader__.load({
  id: '@zhougui/skill-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'skillManager';
    const PANEL_ID = 'skill-manager';
    const inject = ['slots', 'locale'];
    const rpcCtxRef = { ctx: null };

    // Selected scope survives unmount/remount of the panel (leaving and
    // returning to the main slot). Module scope is enough; no store package.
    let rememberedScope = 'personal';

    // Sources the host is allowed to mutate (see spec §Host contract).
    const WRITABLE_SOURCES = {
      'user-dsh': true, 'user-agents': true,
      'project-dsh': true, 'project-agents': true,
    };

    // ---- tiny styling helpers using host theme tokens ----
    const row = {
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 12px', borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
    };
    const btn = (variant) => ({
      border: '1px solid var(--dsw-alias-border-l2)',
      background: variant === 'danger'
        ? 'transparent'
        : 'var(--dsw-alias-bg-layer-2)',
      color: variant === 'danger'
        ? 'var(--dsw-alias-state-error-primary)'
        : 'var(--dsw-alias-label-primary)',
      borderRadius: 6, padding: '5px 10px', cursor: 'pointer',
      fontSize: 13, fontFamily: 'inherit',
    });
    const tab = (active) => ({
      border: '1px solid var(--dsw-alias-border-l2)',
      background: active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
      color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
      borderRadius: 6, padding: '6px 12px', cursor: 'pointer',
      fontSize: 13, fontWeight: active ? 600 : 400, fontFamily: 'inherit',
    });
    const field = {
      width: '100%', boxSizing: 'border-box',
      background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 6, padding: '6px 8px', fontFamily: 'inherit',
    };
    const badge = {
      fontSize: 11, padding: '2px 8px', borderRadius: 999,
      border: '1px solid var(--dsw-alias-border-l1)',
      color: 'var(--dsw-alias-label-secondary)',
      whiteSpace: 'nowrap',
    };
    const warnBadge = {
      ...badge,
      color: 'var(--dsw-alias-state-warning-primary)',
      borderColor: 'var(--dsw-alias-state-warning-primary)',
    };
    const linkBtn = {
      flex: 1, textAlign: 'left', background: 'transparent', border: 'none',
      color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', padding: 0,
      font: 'inherit', minWidth: 0,
    };
    const bannerStyle = {
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '8px 10px', borderRadius: 8, fontSize: 12,
      border: '1px solid var(--dsw-alias-state-error-primary)',
      color: 'var(--dsw-alias-state-error-primary)',
      background: 'var(--dsw-alias-bg-layer-1)',
    };
    const infoBannerStyle = {
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '8px 10px', borderRadius: 8, fontSize: 12,
      border: '1px solid var(--dsw-alias-border-l1)',
      color: 'var(--dsw-alias-label-secondary)',
      background: 'var(--dsw-alias-bg-layer-1)',
    };
    const confirmBar = {
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '8px 10px', borderRadius: 8,
      border: '1px solid var(--dsw-alias-state-error-primary)',
      background: 'var(--dsw-alias-bg-layer-1)',
    };

    // Client->Host bridge: the page's `connection` service carries typed RPC
    // envelopes to the Host's Typert Gateway, which resolves this package's
    // `skillManager` service through its SRC route. The payload must be exactly
    // `{ args: {...} }`; the response is `{ ok: true, value }` or
    // `{ ok: false, error: { code, message, details } }`.
    async function call(endpoint, args) {
      const ctx = rpcCtxRef.ctx;
      if (!ctx) return { ok: false, error: { message: 'client context unavailable' } };
      const conn = ctx.get('connection');
      if (!conn || !conn.rpc || typeof conn.rpc.call !== 'function') {
        return { ok: false, error: { message: 'connection service unavailable' } };
      }
      try {
        return await conn.rpc.call('/api', endpoint, { args: args ?? {} });
      } catch (error) {
        return { ok: false, error: { message: String(error && error.message ? error.message : error) } };
      }
    }

    function errorText(res, fallback) {
      return (res && res.error && res.error.message) ? res.error.message : fallback;
    }

    // ---- info / list hooks ----

    function useInfo() {
      const [info, setInfo] = React.useState(null);
      const [nonce, setNonce] = React.useState(0);
      const reload = React.useCallback(() => setNonce((n) => n + 1), []);
      React.useEffect(() => {
        let cancelled = false;
        void (async () => {
          const res = await call(NS + '/getInfo', {});
          if (!cancelled && res.ok) setInfo(res.value);
        })();
        return () => { cancelled = true; };
      }, [nonce]);
      return { info, reload };
    }

    // The hook records the scope its data belongs to. Until the effect for the
    // new scope resolves, the caller must treat the data as absent: rendering
    // the returned `state` when `state.scope !== scope` blanks `data` so the
    // previous scope's rows can never flash.
    function useSkills(scope) {
      const [state, setState] = React.useState({ scope, data: [], error: null, busy: true });
      const reload = React.useCallback(async () => {
        setState((s) => (s.scope === scope
          ? { ...s, busy: true, error: null }
          : { scope, data: [], error: null, busy: true }));
        const res = await call(NS + '/list', { scope });
        setState((s) => {
          if (s.scope !== scope) return s;
          if (!res.ok) return { ...s, busy: false, error: errorText(res, 'failed') };
          return { ...s, busy: false, error: null, data: Array.isArray(res.value) ? res.value : [] };
        });
      }, [scope]);
      React.useEffect(() => { void reload(); }, [reload]);
      const current = state.scope === scope
        ? state
        : { scope, data: [], error: null, busy: true };
      return { state: current, reload };
    }

    // ---- info helpers ----

    function workspaceKey(ws) {
      return String(ws.id || ws.path || '');
    }

    function personalRootsOf(info) {
      if (!info) return [];
      if (Array.isArray(info.personalRoots) && info.personalRoots.length) return info.personalRoots;
      if (Array.isArray(info.roots)) return info.roots.filter((r) => r.scope === 'personal');
      return [];
    }

    function projectRootsOf(info) {
      if (!info) return [];
      const out = [];
      (Array.isArray(info.workspaces) ? info.workspaces : []).forEach((ws) => {
        (Array.isArray(ws.roots) ? ws.roots : []).forEach((r) => {
          out.push({
            source: r.source, path: r.path,
            workspaceId: ws.id, workspaceTitle: ws.title, workspacePath: ws.path,
          });
        });
      });
      if (out.length) return out;
      if (Array.isArray(info.roots)) return info.roots.filter((r) => r.scope === 'project');
      return [];
    }

    function writableOnly(list) {
      return (Array.isArray(list) ? list : []).filter((r) => r && r.path && WRITABLE_SOURCES[r.source]);
    }

    // Groups project rows by `workspaceId ?? workspacePath`, UNIONed with
    // `info.workspaces` so a workspace with zero skills still renders.
    function projectGroups(info, rows, t) {
      const groups = [];
      const byKey = new Map();
      const lookup = new Map();
      const add = (key, group) => {
        if (!key) return group;
        if (!byKey.has(key)) { byKey.set(key, group); groups.push(group); }
        lookup.set(key, byKey.get(key));
        return byKey.get(key);
      };
      (Array.isArray(info && info.workspaces) ? info.workspaces : []).forEach((ws) => {
        const key = workspaceKey(ws);
        const group = add(key, {
          key, title: ws.title || ws.path || t('allProjects'), path: ws.path || '',
          status: ws.status, roots: Array.isArray(ws.roots) ? ws.roots : [],
          rows: [], complete: true,
        });
        if (ws.path) lookup.set(String(ws.path), group);
      });
      (Array.isArray(rows) ? rows : []).forEach((r) => {
        const key = String(r.workspaceId || r.workspacePath || '');
        let group = lookup.get(key);
        if (!group) {
          group = add(key || 'unknown', {
            key: key || 'unknown',
            title: r.workspaceTitle || r.workspacePath || t('allProjects'),
            path: r.workspacePath || '', status: 'ok', roots: [],
            rows: [], complete: true,
          });
        }
        group.rows.push(r);
        if (r.complete === false) group.complete = false;
      });
      return groups;
    }

    // ---- presentational helpers ----

    function flagChip(t, label, value, readOnly, onClick) {
      const s = {
        fontSize: 11, padding: '3px 8px', borderRadius: 999,
        border: '1px solid ' + (value
          ? 'var(--dsw-alias-state-success-primary)'
          : 'var(--dsw-alias-border-l1)'),
        background: 'transparent',
        color: value
          ? 'var(--dsw-alias-state-success-primary)'
          : 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap', fontFamily: 'inherit',
      };
      const text = label + ' ' + (value ? t('on') : t('off'));
      if (readOnly) return h('span', { style: s, title: t('readOnly') }, text);
      return h('button', {
        type: 'button', onClick, style: { ...s, cursor: 'pointer' },
        title: label + ': ' + (value ? t('on') : t('off')),
      }, text);
    }

    function EditBanner({ t, message, onDismiss }) {
      return h('div', { style: bannerStyle, role: 'alert' },
        h('span', { style: { flex: 1, wordBreak: 'break-word' } }, t('error') + ': ' + message),
        h('button', { type: 'button', onClick: onDismiss, style: btn() }, t('dismiss'))
      );
    }

    function SkillRow({ t, skill, confirming, actions }) {
      const readOnly = !!skill.readOnly;
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('div', { style: row },
          h('button', { type: 'button', onClick: () => actions.onOpen(skill), style: linkBtn },
            h('span', { style: { display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 } },
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, skill.name),
              skill.shadowed ? h('span', { style: warnBadge, title: t('shadowed') }, t('shadowed')) : null
            ),
            h('span', { style: { display: 'block', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, marginTop: 2 } }, skill.description || '—')
          ),
          h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
            h('span', { style: badge, title: t('source') }, skill.source),
            readOnly ? h('span', { style: badge }, t('readOnly')) : null,
            flagChip(t, t('model'), !!skill.modelInvocable, readOnly,
              () => actions.onToggleFlag(skill, { modelInvocable: !skill.modelInvocable })),
            flagChip(t, t('user'), !!skill.userInvocable, readOnly,
              () => actions.onToggleFlag(skill, { userInvocable: !skill.userInvocable })),
            h('button', { type: 'button', onClick: () => actions.onOpen(skill), style: btn() }, t('detail')),
            readOnly ? null : h('button', { type: 'button', onClick: () => actions.onAskDelete(skill), style: btn('danger') }, t('delete'))
          )
        ),
        confirming ? h('div', { style: confirmBar },
          h('span', { style: { flex: 1, fontSize: 12, color: 'var(--dsw-alias-label-primary)' } }, t('deleteConfirm')),
          h('button', { type: 'button', onClick: () => actions.onConfirmDelete(skill), style: btn('danger') }, t('confirmDelete')),
          h('button', { type: 'button', onClick: actions.onCancelDelete, style: btn() }, t('cancel'))
        ) : null
      );
    }

    function RowList({ t, rows, emptyText, pendingKey, actions }) {
      if (!rows.length) {
        return h('div', { style: { color: 'var(--dsw-alias-label-secondary)', padding: '8px 2px', fontSize: 12 } }, emptyText);
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        rows.map((skill) => {
          const key = (skill.workspaceId || skill.workspacePath || 'personal') + ':' + skill.source + ':' + skill.name;
          return h(SkillRow, {
            key, t, skill, confirming: pendingKey === key, actions,
          });
        })
      );
    }

    function SkillDetail({ t, skill, onBack, onRefreshAll, onError }) {
      const [full, setFull] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [flagBusy, setFlagBusy] = React.useState(false);
      const [tick, setTick] = React.useState(0);
      const [desc, setDesc] = React.useState(skill.description || '');
      const [body, setBody] = React.useState('');
      React.useEffect(() => {
        let cancelled = false;
        setFull(null); setError(null);
        void (async () => {
          const res = await call(NS + '/read', {
            scope: skill.scope, skillName: skill.name,
            source: skill.source, workspacePath: skill.workspacePath,
          });
          if (cancelled) return;
          if (res.ok) setFull(res.value);
          else setError(errorText(res, t('loadFailed')));
        })();
        return () => { cancelled = true; };
      }, [skill.name, skill.scope, skill.source, skill.workspacePath, tick]);
      React.useEffect(() => {
        if (full) { setDesc(full.description || ''); setBody(full.body || ''); }
      }, [full]);
      const reloadDetail = () => setTick((n) => n + 1);
      const readOnly = !!(full ? full.readOnly : skill.readOnly);
      const dirty = full !== null && (desc !== (full.description || '') || body !== (full.body || ''));
      const save = async () => {
        if (!full) return;
        setBusy(true);
        const res = await call(NS + '/update', {
          scope: full.scope, skillName: full.name,
          patch: { description: desc, content: body },
          source: full.source, workspacePath: full.workspacePath,
        });
        setBusy(false);
        if (res.ok) { onRefreshAll(); reloadDetail(); }
        else onError(t('actionFailed') + ': ' + errorText(res, t('actionFailed')));
      };
      const setFlag = async (patch) => {
        if (!full) return;
        setFlagBusy(true);
        const res = await call(NS + '/update', {
          scope: full.scope, skillName: full.name, patch,
          source: full.source, workspacePath: full.workspacePath,
        });
        setFlagBusy(false);
        if (res.ok) { onRefreshAll(); reloadDetail(); }
        else onError(t('actionFailed') + ': ' + errorText(res, t('actionFailed')));
      };
      let content;
      if (error) {
        content = h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', padding: 12, fontSize: 12 } }, t('loadFailed') + ': ' + error);
      } else if (full === null) {
        content = h('div', { style: { color: 'var(--dsw-alias-label-secondary)', padding: 12 } }, t('loading'));
      } else {
        content = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
          h('div', { style: { ...row, justifyContent: 'space-between' } },
            h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, wordBreak: 'break-all', minWidth: 0 } }, full.path || ''),
            h('span', { style: badge }, full.source)
          ),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } }, t('description')),
            h('input', {
              value: desc, disabled: readOnly,
              onChange: (e) => setDesc(e.target.value), style: field,
            })
          ),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } }, t('modelInvocation')),
            flagChip(t, t('model'), !!full.modelInvocable, readOnly || flagBusy,
              () => setFlag({ modelInvocable: !full.modelInvocable })),
            h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, marginLeft: 8 } }, t('userInvocation')),
            flagChip(t, t('user'), !!full.userInvocable, readOnly || flagBusy,
              () => setFlag({ userInvocable: !full.userInvocable }))
          ),
          h('label', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } }, t('body')),
          h('textarea', {
            value: body, rows: 12, disabled: readOnly,
            onChange: (e) => setBody(e.target.value),
            style: { ...field, resize: 'vertical', fontFamily: 'monospace' },
          }),
          h('div', { style: { display: 'flex', gap: 8 } },
            readOnly
              ? h('span', { style: badge }, t('readOnly'))
              : h('button', { type: 'button', onClick: save, disabled: busy || !dirty, style: btn() }, busy ? t('saving') : t('save')),
            h('button', { type: 'button', onClick: () => { onRefreshAll(); reloadDetail(); }, style: btn() }, t('refresh'))
          )
        );
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h('div', { style: row },
          h('button', { type: 'button', onClick: onBack, style: btn() }, '← ' + t('back')),
          h('span', { style: { fontWeight: 700, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, skill.name)
        ),
        content
      );
    }

    function CreateForm({ t, scope, info, onCreated, onCancel, onError }) {
      const workspaces = scope === 'project' && info && Array.isArray(info.workspaces)
        ? info.workspaces.filter((w) => w.status !== 'missing-dir')
        : [];
      const [wsKey, setWsKey] = React.useState(() => {
        const first = workspaces[0];
        return first ? workspaceKey(first) : '';
      });
      const [source, setSource] = React.useState('');
      const [name, setName] = React.useState('');
      const [desc, setDesc] = React.useState('');
      const [busy, setBusy] = React.useState(false);

      const ws = scope === 'project'
        ? (workspaces.find((w) => workspaceKey(w) === wsKey) || workspaces[0] || null)
        : null;
      const options = scope === 'project'
        ? writableOnly(ws ? ws.roots : [])
        : writableOnly(personalRootsOf(info));
      const effectiveSource = options.some((o) => o.source === source)
        ? source
        : (options.length ? options[0].source : '');
      const workspacePath = ws ? ws.path : undefined;
      const canSubmit = !!name.trim() && !!desc.trim() && !!effectiveSource && !busy
        && (scope !== 'project' || !!ws);

      const submit = async () => {
        setBusy(true);
        const res = await call(NS + '/create', {
          scope,
          opts: {
            name: name.trim(), description: desc.trim(),
            source: effectiveSource || undefined,
            workspacePath,
          },
        });
        setBusy(false);
        if (res.ok) onCreated();
        else onError(t('actionFailed') + ': ' + errorText(res, t('actionFailed')));
      };

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, padding: 12, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)' } },
        h('div', { style: { fontWeight: 600 } }, t('create')),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } }, t('name')),
          h('input', { value: name, placeholder: t('nameHint'), onChange: (e) => setName(e.target.value), style: field }),
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11 } }, t('nameHint'))
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } }, t('description')),
          h('input', { value: desc, onChange: (e) => setDesc(e.target.value), style: field })
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } }, t('location')),
          scope === 'project'
            ? h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11 } }, t('workspace'))
            : null,
          scope === 'project'
            ? h('select', {
              value: ws ? workspaceKey(ws) : '',
              onChange: (e) => setWsKey(e.target.value),
              style: field,
            },
              workspaces.length
                ? workspaces.map((w) => h('option', { key: workspaceKey(w), value: workspaceKey(w) }, w.title || w.path || workspaceKey(w)))
                : h('option', { value: '' }, t('noProjects'))
            )
            : null,
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11 } }, t('source')),
          h('select', {
            value: effectiveSource,
            onChange: (e) => setSource(e.target.value),
            style: field,
          },
            options.length
              ? options.map((o) => h('option', { key: o.source, value: o.source }, o.source + ' · ' + o.path))
              : h('option', { value: '' }, t('noRoot'))
          )
        ),
        h('div', { style: { display: 'flex', gap: 8 } },
          h('button', { type: 'button', onClick: submit, disabled: !canSubmit, style: btn() }, busy ? t('creating') : t('create')),
          h('button', { type: 'button', onClick: onCancel, style: btn() }, t('cancel'))
        )
      );
    }

    function ScopeTabs({ t, scope, onScope }) {
      return h('div', { style: { display: 'flex', gap: 8 } },
        h('button', { type: 'button', onClick: () => onScope('personal'), style: tab(scope === 'personal') }, t('personal')),
        h('button', { type: 'button', onClick: () => onScope('project'), style: tab(scope === 'project') }, t('project'))
      );
    }

    function SkillManagerPage({ t }) {
      const { info, reload: reloadInfo } = useInfo();
      const [scope, setScope] = React.useState(rememberedScope === 'project' ? 'project' : 'personal');
      const { state, reload } = useSkills(scope);
      const [selected, setSelected] = React.useState(null);
      const [creating, setCreating] = React.useState(false);
      const [pendingDelete, setPendingDelete] = React.useState(null);
      const [banner, setBanner] = React.useState(null);
      const [dismissedError, setDismissedError] = React.useState(null);

      const refreshAll = React.useCallback(() => { reload(); reloadInfo(); }, [reload, reloadInfo]);

      // Only ever render rows belonging to the scope we asked for.
      const current = state.scope === scope ? state : { scope, data: [], error: null, busy: true };
      const listError = current.error && current.error !== dismissedError ? current.error : null;

      const changeScope = (s) => {
        rememberedScope = s;
        setScope(s);
        setSelected(null);
        setCreating(false);
        setPendingDelete(null);
        setDismissedError(null);
      };

      const fail = (res, fallback) => setBanner(errorText(res, fallback));

      const toggleFlag = async (skill, patch) => {
        setBanner(null);
        const res = await call(NS + '/update', {
          scope: skill.scope, skillName: skill.name, patch,
          source: skill.source, workspacePath: skill.workspacePath,
        });
        if (res.ok) refreshAll();
        else fail(res, t('actionFailed'));
      };

      const confirmDelete = async (skill) => {
        setBanner(null);
        const res = await call(NS + '/remove', {
          scope: skill.scope, skillName: skill.name,
          source: skill.source, workspacePath: skill.workspacePath,
        });
        setPendingDelete(null);
        if (res.ok) {
          if (selected && selected.name === skill.name && selected.source === skill.source) setSelected(null);
          refreshAll();
        } else fail(res, t('actionFailed'));
      };

      const actions = {
        onOpen: (s) => { setCreating(false); setSelected(s); },
        onToggleFlag: toggleFlag,
        onAskDelete: (s) => setPendingDelete(
          (s.workspaceId || s.workspacePath || 'personal') + ':' + s.source + ':' + s.name
        ),
        onCancelDelete: () => setPendingDelete(null),
        onConfirmDelete: confirmDelete,
      };

      const paths = (scope === 'personal' ? personalRootsOf(info) : projectRootsOf(info))
        .map((r) => r.path).filter(Boolean);
      const rootLabel = paths.length ? paths.join(', ') : t('noRoot');

      const header = h('div', { style: { flex: '0 0 auto', paddingBottom: 10 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h('span', { style: { fontWeight: 700, fontSize: 16 } }, t('title')),
          // Label is constant: only `disabled` follows busy, so the header
          // never reflows on refresh.
          h('button', { type: 'button', onClick: refreshAll, style: btn(), disabled: current.busy }, t('refresh')),
          h('button', { type: 'button', onClick: () => { setSelected(null); setCreating(!creating); }, style: btn() }, t('create'))
        ),
        h('div', { style: { marginTop: 8 } }, h(ScopeTabs, { t, scope, onScope: changeScope })),
        h('div', {
          style: {
            color: 'var(--dsw-alias-label-secondary)', fontSize: 12, marginTop: 6,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          },
          title: rootLabel,
        }, rootLabel)
      );

      const banners = [];
      if (banner) banners.push(h(EditBanner, { key: 'action-error', t, message: banner, onDismiss: () => setBanner(null) }));
      if (listError) banners.push(h(EditBanner, { key: 'list-error', t, message: listError, onDismiss: () => setDismissedError(listError) }));
      if (info && info.skillsService === false) {
        banners.push(h('div', { key: 'skills-service', style: infoBannerStyle }, t('skillsUnavailable')));
      }

      let content;
      if (selected) {
        content = h(SkillDetail, {
          t, skill: selected,
          onBack: () => setSelected(null),
          onRefreshAll: refreshAll,
          onError: (message) => setBanner(message),
        });
      } else if (creating) {
        content = h(CreateForm, {
          t, scope, info,
          onCreated: () => { setCreating(false); refreshAll(); },
          onCancel: () => setCreating(false),
          onError: (message) => setBanner(message),
        });
      } else if (current.busy && !current.data.length) {
        content = h('div', { style: { color: 'var(--dsw-alias-label-secondary)', padding: 12 } }, t('loading'));
      } else if (scope === 'personal') {
        content = h(RowList, {
          t, rows: current.data,
          emptyText: t('personalEmpty'),
          pendingKey: pendingDelete, actions,
        });
      } else {
        const groups = projectGroups(info, current.data, t);
        const workspaces = info && Array.isArray(info.workspaces) ? info.workspaces : [];
        if (!info) {
          content = h('div', { style: { color: 'var(--dsw-alias-label-secondary)', padding: 12 } }, t('loading'));
        } else if (!workspaces.length) {
          content = h('div', { style: { color: 'var(--dsw-alias-label-secondary)', padding: '8px 2px', fontSize: 12 } }, t('noProjects'));
        } else {
          content = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
            current.data.length ? null : h('div', {
              style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
            }, t('allProjectsEmpty')),
            groups.map((g) => {
              const missing = g.status === 'missing-dir';
              return h('div', { key: 'ws:' + g.key, style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                  h('span', { style: { fontWeight: 600, fontSize: 13, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, g.title),
                  h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, g.path),
                  h('span', { style: badge }, String(g.rows.length) + ' ' + t('skillsCount')),
                  missing ? h('span', { style: warnBadge }, t('projectMissing')) : null,
                  g.complete === false
                    ? h('span', { style: warnBadge, title: t('skillsUnavailable') }, '⚠ ' + t('skillsUnavailable'))
                    : null
                ),
                missing
                  ? null
                  : h(RowList, {
                    t, rows: g.rows,
                    emptyText: t('projectEmpty'),
                    pendingKey: pendingDelete, actions,
                  })
              );
            })
          );
        }
      }

      // Root is the scroll container: it is the flex item of a
      // `display:flex;flex-direction:column;overflow:hidden` column with a
      // definite height and no scrolling ancestor, so 100% height + an inner
      // scrolling body region is the only layout that exposes a scrollbar.
      return h('div', {
        style: {
          boxSizing: 'border-box', height: '100%',
          display: 'flex', flexDirection: 'column',
          padding: '16px 16px 0', maxWidth: 760,
        },
      },
        header,
        h('div', {
          style: {
            flex: '1 1 auto', minHeight: 0, overflowY: 'auto',
            paddingBottom: 16, display: 'flex', flexDirection: 'column', gap: 10,
          },
        }, banners, content)
      );
    }

    function PanelIcon({ size }) {
      const s = size || 18;
      return h('svg', { viewBox: '0 0 64 64', width: s, height: s, 'aria-hidden': true },
        h('rect', { x: 10, y: 8, width: 44, height: 48, rx: 8, fill: 'var(--dsw-alias-brand-primary)' }),
        h('rect', { x: 18, y: 16, width: 28, height: 4, rx: 2, fill: '#fff' }),
        h('rect', { x: 18, y: 26, width: 28, height: 4, rx: 2, fill: 'rgba(255,255,255,0.6)' }),
        h('rect', { x: 18, y: 36, width: 18, height: 4, rx: 2, fill: 'rgba(255,255,255,0.6)' }),
        h('circle', { cx: 42, cy: 40, r: 5, fill: '#4fc3a1' }),
        h('path', { d: 'M40 40l1.5 1.5L44 38', stroke: '#fff', strokeWidth: 2, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' })
      );
    }

    return {
      inject,
      apply(ctx) {
        rpcCtxRef.ctx = ctx;
        ctx.effect(() => ctx.locale.register(NS, {
          en: {
            'title': 'Skill Manager',
            'refresh': 'Refresh',
            'create': 'New skill',
            'back': 'Back',
            'save': 'Save',
            'saving': 'Saving…',
            'creating': 'Creating…',
            'loading': 'Loading…',
            'cancel': 'Cancel',
            'error': 'Error',
            'panel': 'Skills',
            'personal': 'Personal',
            'project': 'Project',
            'source': 'Source',
            'location': 'Location',
            'description': 'Description',
            'body': 'Body',
            'model': 'Model',
            'user': 'User',
            'on': 'on',
            'off': 'off',
            'modelInvocation': 'Model invocation',
            'userInvocation': 'User invocation',
            'readOnly': 'Read-only',
            'shadowed': 'Shadowed by higher priority',
            'detail': 'Details',
            'delete': 'Delete',
            'deleteConfirm': 'Delete this skill? Its files will be removed.',
            'confirmDelete': 'Confirm delete',
            'dismiss': 'Dismiss',
            'noRoot': 'No scope configured.',
            'allProjects': 'All projects',
            'projectEmpty': 'No skills in this project yet.',
            'allProjectsEmpty': 'No skills in any project yet.',
            'personalEmpty': 'No personal skills yet.',
            'projectMissing': 'Directory missing',
            'noProjects': 'No workspaces registered yet.',
            'skillsUnavailable': 'Skill discovery service unavailable; showing file-scan results only.',
            'name': 'Name',
            'nameHint': 'kebab-case, e.g. my-skill',
            'workspace': 'Project',
            'skillsCount': 'skills',
            'loadFailed': 'Failed to load',
            'actionFailed': 'Action failed',
          },
          zh: {
            'title': '技能管理器',
            'refresh': '刷新',
            'create': '新建技能',
            'back': '返回',
            'save': '保存',
            'saving': '保存中…',
            'creating': '创建中…',
            'loading': '加载中…',
            'cancel': '取消',
            'error': '错误',
            'panel': '技能',
            'personal': '个人级',
            'project': '项目级',
            'source': '来源',
            'location': '位置',
            'description': '描述',
            'body': '正文',
            'model': '模型',
            'user': '用户',
            'on': '开',
            'off': '关',
            'modelInvocation': '模型调用',
            'userInvocation': '用户调用',
            'readOnly': '只读',
            'shadowed': '被更高优先级覆盖',
            'detail': '详情',
            'delete': '删除',
            'deleteConfirm': '删除该技能？其文件将被移除。',
            'confirmDelete': '确认删除',
            'dismiss': '关闭',
            'noRoot': '未配置范围。',
            'allProjects': '所有项目',
            'projectEmpty': '该项目暂无技能。',
            'allProjectsEmpty': '所有项目中都还没有技能。',
            'personalEmpty': '个人级暂无技能。',
            'projectMissing': '目录不存在',
            'noProjects': '尚未注册任何工作区。',
            'skillsUnavailable': '技能发现服务不可用，仅显示文件扫描结果。',
            'name': '名称',
            'nameHint': 'kebab-case，例如 my-skill',
            'workspace': '项目',
            'skillsCount': '个技能',
            'loadFailed': '加载失败',
            'actionFailed': '操作失败',
          },
        }), 'skill-manager: dictionaries');
        const t = ctx.locale.bind(NS);
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID, locale: NS,
        }, () => h(SkillManagerPage, { t })));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: () => t('panel'), locale: NS,
        }, ({ size }) => h(PanelIcon, { size })));
      },
    };
  },
});
