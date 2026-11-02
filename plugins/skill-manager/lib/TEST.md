# skill-manager — testing notes

This file used to contain a stale dump of an older `lib/index.js` (single `{ root }`
config, `inject: ['skills', 'commands']`, schemastery `Config`). That content described
an implementation that no longer exists; it has been removed. Nothing here is a second
copy of the plugin source.

## Host smoke test

```
node test/host.mjs        # or: pnpm test  (package.json -> scripts.test)
```

The test imports `apply` from `../lib/index.js`, drives it with a fake Cordis `ctx`
(no live Harness required), and asserts the Host contract:

- `getInfo()` shape: `scopes`, `personalRoots`, `roots`, `workspaces`, `skillsService`,
  `readOnlySources`, `config`
- canonical project roots — `<P>/.dsh/skills` and `<P>/.agents/skills`, never
  `<P>/.dsh/.agents/skills`
- multi-project enumeration through a fake `workspaceRegistry` (`ok` and `missing-dir`)
- per-workspace skill discovery, including `workspaceId` / `workspacePath` / `complete`
  on every row
- **discovery precedence**: the filesystem scan is primary and the `skills.snapshot()`
  rows are merged on top (deduped by `source + "\0" + name`). An empty *or throwing*
  snapshot must not hide the managed roots, and must not mark disk rows `complete:false`
- **identity is the physical file**: filesystem rows collapse by
  `pathKey(row.path)` (`realpathSync.native`), never by name — two directories in one
  root that declare the same name both stay listed with the loser `shadowed`, a
  junction/symlink alias of a root adds no duplicates, and `row.path` always stays the
  as-scanned `SKILL.md` (never the realpath, which `read()` depends on). Snapshot rows
  are deduped against disk (`diskNames`) *and* against each other (`svcSeen`); a
  snapshot-only row is never dropped
- `rank` / `shadowed` / `readOnly` modelling, and both rows of a same-name collision
- `setEnabled` touches only `disable-model-invocation`; `user-invocable` survives
- read-only sources (`custom`, `bundled`, `runtime`) are listed but every mutation
  refuses them
- `.system` is skipped only under `user-dsh`
- readdir failures mark a group incomplete instead of reporting it empty
- typert wire signatures keep simple identifiers, with a trailing `workspacePath`
  on the mutating methods

All checks must print `ok`; the run ends with `ALL PASS` and exit code 0.

## Why the filesystem scan has to be primary

Learned the hard way, from a live regression: the Personal tab listed nothing.

```
plugin_manager list_plugins            -> include:skill-manager  enabled:true, fiberPhase:"active"
Config.listConfigs {name:"@deepseek-ai/dsh-skill-filesystem"}
                                      -> 1 entry, include:skill-filesystem, status:"inactive"
```

The shipped filesystem provider is not mounted by the *profile*; an agent preset mounts it,
which files it into **that preset's layer**. The `skills` contract says a read *"merges the
global layer with the viewing scope's chain"*, and this plugin is a profile-level (host) row,
so `ctx.skills.snapshot({})` (no `scope`) merges only the global layer and legitimately
observes zero skills while `D:\tools\DSH\data\skills` is full. Using the snapshot as the only
source when the service existed made the panes silently empty.

Consequences for any future change here:

- Do **not** make `ctx.skills` the sole source. It is a union source: good for sources with no
  root in this process (`custom`, `bundled`, `runtime`) and for roots we were not told about,
  never a replacement for scanning the roots we manage.
- `getInfo().skillsService` only reports that the service object exists. It is not evidence
  that the service can see anything, and it must not be used as a "the list should be
  non-empty" assertion.
- To probe the live directories without the GUI, point a throwaway script at
  `personalRoot` with `DSH_HOME=D:\tools\DSH\data` and a ctx whose `get('skills')` returns
  `null`; `list('personal')` should return the 7 `user-dsh` skills, and
  `read('personal','network-connect')` should return a non-empty body.

## Client

There is no automated client test. `node --check client.js` verifies syntax only.
The Client half is a hand-written plain-JS Client module
(`window.__ModuleLoader__.load`), so it has no build step.

## What this test cannot cover

- No visual or browser verification: the scroll container, header stability and the
  project grouping are asserted as exact style/behaviour strings, not rendered.
- The fake `skills` / `workspaceRegistry` services implement the documented contracts,
  not the shipped provider's full internal behaviour. A live profile run is the only
  end-to-end check, and the live provider is measurably narrower than the contract
  suggests (see "Why the filesystem scan has to be primary").
- Host changes need a DSH restart, not just a page refresh: the profile keeps the
  JavaScript module generation it loaded, so `lib/index.js` edits only take effect on
  the next start. Client-only edits need a page reload unless `pnpm run dev:web` is running.
- Browser HMR: a Client change is picked up without a page refresh only while
  `pnpm run dev:web` is running in the DSH checkout; otherwise reload the page.
