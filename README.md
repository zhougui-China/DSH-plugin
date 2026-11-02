# DSH-plugin

A monorepo of [DeepSeek Harness](https://github.com/DeepSeek-Harness/dsh) plugins.
Each child of `plugins/` is an independent npm package that can be installed into a
DSH profile with `plugin_manager install_bundle`.

## Plugins

| Package | Description |
| --- | --- |
| [@zhougui/skill-manager](./plugins/skill-manager) | Visually browse and manage project-level and personal-level skills. |

## Structure

```
plugins/
  <plugin-name>/        # one publishable plugin bundle per folder
    package.json        # npm package metadata + dsh.bundle.patch / dsh.client
    cordis.patch.yml    # loader patch (Host row)
    client.js           # optional web Client half
    lib/index.js        # Host half (Cordis plugin apply)
```

## Install a plugin into DSH

From the DSH Web GUI, install the published package, e.g.:

```
plugin_manager install_bundle @zhougui/skill-manager@1.0.0
```

## Monorepo commands

```
pnpm install   # install all workspace packages
pnpm test      # run tests for every plugin
```

## Publish a plugin

```
cd plugins/<name>
npm publish    # publishConfig.access = public
```
