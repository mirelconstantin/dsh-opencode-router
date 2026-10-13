# AGENTS.md

Working notes for anyone — human or agent — changing this plugin.

## Bump the version on every release

**Every change that ships gets a new version number.** Publishing the same
version twice fails on npm — the name is taken forever, and `npm publish`
refuses a duplicate rather than overwriting. There is no `npm unpublish` that
brings a version back, so the number you bump to is the number that exists
publicly.

Bump **patch** by default: `1.1.1` → `1.1.2` → `1.1.3`. Take **minor**
(`1.1.x` → `1.2.0`) for a new capability, and **major** (`1.x` → `2.0.0`) only
for a change that breaks an existing configuration or the plugin's contract.

One place only: the `version` field in `package.json`. There is no second copy
to keep in sync.

Before publishing, confirm the number is not taken:

```sh
npm view dsh-opencode-router versions
```

### Release sequence

```sh
# 1. Bump. 1.1.1 -> 1.1.2
npm version patch --no-git-tag-version

# 2. Gate. `build` cleans lib/, so it must precede build:client, and the
#    artifact tests read the built bundle.
pnpm run typecheck
pnpm run build
pnpm run build:client
pnpm test
pnpm run verify:all

# 3. Commit and tag.
git commit -am "1.1.2: <what changed, and why>"
git tag -a v1.1.2 -m "1.1.2 — <one line>"
git push origin main && git push origin v1.1.2

# 4. Publish. npm login first if this machine is not authenticated.
npm publish --access public
npm tag add latest@1.1.2
```

`prepack` runs automatically on publish and rebuilds `lib/`, so a stale
`lib/` cannot ship. `check-plugin` and `check-patch` run inside it.

## Client bundle rules

The client half is loaded into the host's own bundle, so its import rules are
stricter than the server half's:

- **Value imports** are allowed only from `react`, `react-dom`,
  `@deepseek-ai/cordis`, `dsh-client-ui-slots` and
  `dsh-client-ui-primitives`. Every other `@deepseek-ai/*` must be
  `import type {}` so it is erased at build time.
- The client registers under an id **equal to `manifest.name`**
  (`dsh-opencode-router`) or `verify:all` fails.
- Keep the client in **one** CSS module. A second `.module.css` would give the
  bundle a second style tag, and `test/client-load.test.ts` asserts exactly
  one.
- `test/artifacts.test.ts` and `test/client-load.test.ts` read the built
  bundle, so they fail with ENOENT when `lib/client.js` is missing. That is a
  missing build, not a defect.

## Config defaults live in two places

`IpPoolConfigSchema` in `src/ip-pool-settings/namespace.ts` **and**
`resolveIpPoolSettings` in the same file. The second reads the host's volatile
config, which is **not validated**, so it bypasses the schema entirely.

They have drifted apart before: the schema said `enabled: false` while the
resolver said the same, and a fresh install shipped with routing off — every
user had to visit settings before anything worked. Changing only the schema
would have shipped a pool that claims to be on and is not.

Change both, and keep `test/settings-contract.test.ts` green: it asserts a
fresh install works with no configuration, that an explicit `false` still
switches the pool off, and that `free.targetSize` suits the measured
admission rate.

## Locale

`ctx.locale.register` takes `Record<BuiltInLocaleId, ...>` where the ids are
fixed to exactly `["zh", "en"]`. A plugin that omits `zh` does not typecheck
and does not load, so the key must exist — this plugin ships English only and
defines `export const zh = en`, one set of strings, no second dictionary to
drift. Do not add translated copy.

## Comments

Comments state the contract and the reason, not a transcript of the change
and not a restatement of the code. No metaphors. Prefer the exact term: write
"the JSON fields", not "the response shape".

## Commands

```sh
pnpm run typecheck      # tsc --noEmit
pnpm run build          # server half; CLEANS lib/
pnpm run build:client   # client half; must follow build
pnpm test               # node --test --experimental-strip-types
pnpm run verify:all     # check-plugin + check-patch
pnpm run check:patch    # profile patch, when cordis.patch.yml changes
npm run test:live       # real-API smoke; needs network, not for CI
```