<p align="center">
  <img src="https://raw.githubusercontent.com/pazalo/.github/main/assets/pazalo-logo.png" width="112" alt="Pazalo">
</p>

<h1 align="center">dsh-opencode-router</h1>

<p align="center">
  Free OpenCode Zen models inside DeepSeek Harness. No API key, no account, no extra process. When
  the free lane rate-limits your IP, a pool of proxy exits takes over and the model picker keeps
  working.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%3E%3D22.19-FFC24D?style=flat-square&logo=node&logoColor=black" alt="Node">
  <img src="https://img.shields.io/badge/Tests-72-FFC24D?style=flat-square" alt="Tests">
  <img src="https://img.shields.io/badge/Exits-scalable-F0522C?style=flat-square" alt="Exit pool scaling">
  <img src="https://img.shields.io/badge/Licence-MIT-F0522C?style=flat-square" alt="Licence">
</p>

## Install

Install it and it works: the exit pool starts **on**, scrapes public proxy
lists, and rotates your requests across every exit that can actually reach the
API. There is nothing to configure, no account, no API key, and no tunnel to
start. Watch it happen in the composer chip (below the input), where exits
appear as they are admitted — normally within a minute of the first message.

From the GUI's **Add plugin** box:

```
dsh-opencode-router
```

or from a terminal, where the profile name is required:

```bash
dsh plugin add dsh-opencode-router --profile web
```

<details>
<summary>Other routes</summary>

| Route | Command |
|---|---|
| Pinned to a version | `dsh plugin add dsh-opencode-router@1.1.0 --profile web` |
| Pinned to a commit | `dsh plugin add github:mirelconstantin/dsh-opencode-router#<sha>` |
| Tarball | `dsh plugin add ./dsh-opencode-router-1.1.0.tgz` |
| Local checkout | `dsh plugin add /absolute/path/to/dsh-opencode-router` |

</details>

Restart the profile, open the model picker, and pick a model from the **opencode2dsh** group.
Everything is optional: the pool ships disabled, so installing changes nothing until you turn it on.

## What it does

The plugin registers a native `dsh-llm` adapter that streams straight from OpenCode Zen's
anonymous free lane, the same models OpenCode's own CLI uses without signing in. Requests carry the
CLI's user agent and its session, request and project headers, so upstream sees ordinary CLI
traffic.

**The model catalog keeps itself fresh** through a three-step fallback: the live upstream list,
then an offline cache, then a verified static list. Pricing metadata from models.dev decides which
models count as free. Nothing about this needs a key.

**A proxy exit pool takes over when your IP is throttled.** The anonymous lane meters quota per
exit IP, so one IP runs out while others still serve. The pool fills from four sources (public free
lists, addresses you paste, subscription URLs, and a GoProxy converter), probes each candidate,
and routes every request through the healthiest exit:

| Source | Where it comes from |
|---|---|
| `free` | Public proxy lists, fetched and screened. On by default |
| `manual` | Addresses you paste, one per line |
| `subscription` | Clash or V2ray subscription URLs. Plaintext nodes dial directly, encrypted ones convert through sing-box |
| `goproxy` | Nodes the GoProxy adapter contributes |

An exit that returns 429 cools down with exponential backoff, so the rest of the pool keeps serving.
A model-specific refusal, which is usually a region block rather than a broken proxy, bans only
that exit-and-model pair. A dead exit is dropped after repeated failures. Real traffic teaches the
pool as it goes: every response the router sees updates the same health the prober writes, so no
probe quota is spent on exits that are already in use.

## Seeing and choosing the proxy you are on

A compact control sits under the composer — the bottom dock beside the
context meter — for as long as the plugin is loaded. The chip names the exit
your last request went through, or reads `direct` when nothing was proxied;
its colour says whether that exit is still usable. A pool that is on but has
no usable exit, or one that handed the global dispatcher to another plugin,
says so, because "the pool is enabled" and "your traffic is proxied" are
different facts.

**Click it to choose.** The picker offers three answers, and they are not
interchangeable:

| Row | Meaning |
|---|---|
| *No proxy (direct)* | Route nothing. Every request goes out direct. |
| *Automatic* | Let the pool choose and rotate. |
| an exit row | Pin that exit until you change it. A dead exit can be pinned on purpose, which is how you debug a bad node. |

Each exit row carries a state dot, its latency, and what it has cost you:

- **Tokens** — the total that exit has carried, across every finished request,
  broken out so a heavy conversation is visible. Next to it, the **share that
  came from the prompt cache**: a cached prefix is billed far below a fresh
  one, so a high percentage means the exit is carrying long sessions cheaply.
  The tooltip explains the number.
- **When it was last used** — `3 uses · 2m ago`.

Rows order themselves the way you would choose: the current pin, then healthy
exits, then ones that have actually carried traffic, then the rest by recency.
A proven exit beats an untested one of the same health.

*No proxy* is deliberately not the same as *Automatic*: unpinned still routes,
and you may want routing off without touching settings. It also outranks a
pin, so a pin left over from earlier cannot quietly resurrect routing.

The chip reads the same `/status` bridge the settings page polls and writes
through a loopback-guarded `POST /pin`, so it adds no new transport and no
new configuration. It is deliberately not gated on the settings page being
open: you need it mid-conversation, when the pool is misbehaving.

The chip follows your **routing decision**, not just completed traffic:
*No proxy* and a pinned exit both change the label the moment you click,
because that is where the next request goes. A pin that has not carried
traffic yet is labelled as a pin rather than claiming a request went through
it. With nothing pinned, the readout falls back to the last completed
request, so between a 429 rotation and the next one it names the exit the
session is about to leave — which the tooltip states rather than hiding.
Usage tallies and token counts are in-memory: they count this process's
routing, not a durable record, and reset on restart.

## How long one exit lasts

The Zen free lane meters **per IP, per UTC day** — the bucket key is
`ratelimit:ip:<ip>:<YYYYMMDD>`, not per API key and not global. Two things
follow, and both are why rotation is worth having:

- **A new exit IP is a fresh, empty bucket.** Rotation genuinely multiplies
  the day's allowance rather than just spreading it around.
- **The reset is midnight UTC, not 24h after your first request.** A 429 at
  23:00 UTC clears in about an hour; at 01:00 UTC you wait nearly 23. This is
  the upstream's own `retry-after` value, and the pool now uses it verbatim
  when it arrives, computing the same reset itself when it does not.

A *fresh* IP is treated more generously than an established one: below a
lifetime threshold the upstream allows double the daily cap, so recently-seen
exits are worth more than long-used ones.

**The cap itself is not published.** The number lives in a server-side secret;
the widely-quoted "200 requests/day" is community folklore with no official
source. Plan against your own measured throughput, not that figure. Also note
the cap counts **requests, not tokens** — a long agentic turn and a one-line
prompt each cost one — and free models are IP-metered *even when
authenticated*, because that is a property of the model, not the request.

Two rotation details that look like bugs: IPv6 is truncated to a /64, so
rotating addresses inside one /64 does nothing; and only the `retry-after`
header is published, with no `x-ratelimit-remaining` to read.

Note also that the limiter above was last open-sourced 2026-10-11 and Zen is
now a thin proxy to a closed service, so these numbers can change without
notice. See `research/opencode-zen-rate-limits.md` for the sources and the
confirmed/inferred/unknown split.

## Managing a lot of proxies

The settings page lives on the Plugins page, under the plugin's row, and every change applies on
save without a restart.

**Paste a whole list.** Both address fields have a bulk paste box. Drop in a few hundred lines, and
the summary tells you what will land before you commit it: how many will be added, how many were
skipped as duplicates, and how many could not be read. Equivalent spellings count as duplicates, so
`http://Host:080` and `http://host:80` are one entry rather than two. Blank lines and `#` comments
are ignored.

**See how full the pool is at a glance.** The capacity meter shows available exits against the
target, and the state badge reads healthy, low, critical or depleted. The exit table lists every
exit with its source, region, latency, quality grade, live state and model bans, and you can probe
or pin any one of them from its row.

**Pin a primary exit** when you have a node you trust, such as a local Clash mixed port. Pinning
keeps that exit in front of the rotation pool. Turn on absolute pinning and failures pass through
instead of rotating, which is what you want when the node must be used.

### Settings

Defaults work out of the box. Override them in the profile's `cordis.patch.yml`:

```yaml
- id: opencode2dsh
  name: 'dsh-opencode-router'
  config:
    providerId: opencode2dsh
    refreshSeconds: 300
    ipPool:
      enabled: true
      free:
        enabled: true
        targetSize: 200
```

| Option | Default | Description |
|---|---|---|
| `providerId` | `opencode2dsh` | Provider name shown in DSH. |
| `refreshSeconds` | `300` | Live catalog refresh interval. |
| `ipPool.enabled` | `true` | **On out of the box — a fresh install routes and rotates with no configuration.** Off means every request goes direct, exactly as if the pool were absent. |
| `ipPool.free.enabled` | `true` | Fetch and admit public proxy lists. |
| `ipPool.free.targetSize` | `30` | How many usable free exits to keep. The schema accepts 1 to 1000; selection and admission are linear in this number. 30 suits the measured admission rate: about 11% of scraped candidates can actually reach the API, and free proxies usually die within the hour, so a smaller target spends most of its life in the emergency state. |
| `ipPool.free.blockedCountries` | `["CN"]` | ISO country codes whose exits are refused. |
| `ipPool.manual` | `[]` | Proxy addresses, `http://host:port` or `socks5://host:port`. |
| `ipPool.subscription.urls` | `[]` | Subscription URLs, refreshed on `refreshMs`. |
| `ipPool.subscription.refreshMs` | `1800000` | Subscription pull interval. |
| `ipPool.singbox.path` | `sing-box` | Conversion core for encrypted subscription nodes. |
| `ipPool.probeModels` | `[]` | Models used to probe exits. Empty means the default, `big-pickle`. |
| `ipPool.maxConcurrentProbes` | `3` | Concurrent probes across distinct exits, 1 to 32. One exit is always probed serially. |
| `ipPool.pinnedExitId` | `""` | Address of the primary exit. |
| `ipPool.pinnedStrict` | `false` | Absolute pinning: fail rather than rotate or go direct. |
| `firstEventMs` | `30000` | Watchdog for time to the first stream event. |
| `bodyIdleMs` | `120000` | Watchdog for silence mid-response. |
| `responsesBodyIdleMs` | `300000` | The same floor for Responses-only models. |

Every setting is editable from the Plugins page, which is usually easier than the patch file.

## Scaling

The pool is built to hold hundreds of exits without the routing path paying for the ones it is not
using.

- **Selection is a single pass.** Each request scans the exits once and keeps the best, rather than
  building and sorting a list of every exit. Health and cooldown state are read from the pool, and
  the candidate list is rebuilt only when the pool actually changes.
- **Ban bookkeeping is indexed per exit.** Whether an exit is exhausted for its models is a count
  comparison against that exit's own ban set, not a scan of the whole ban table. Availability for
  the pool state, the admission quota and the status page is one pass over the exits.
- **Exit addresses are indexed.** Adding a candidate checks its exit IP in a map, so admitting a few
  hundred candidates is linear rather than quadratic.
- **Proxy agents are evicted in constant time.** The per-exit agent cache keeps its own recency
  order, and the cap is 64 by default, so a working set larger than the old cap stops re-dialling.
- **Screening claims work by index.** The coarse screen hands each worker the next candidate instead
  of shifting the queue, which removes a quadratic cost over a list of up to 20,000 candidates.

Selection order is unchanged by any of this: a pinned exit wins while usable, then the session's
previous exit, then healthy over unknown, then fewer consecutive 429s, then lower latency, then a
random pick among equals.

## Health and troubleshooting

The plugin writes a status snapshot after each refresh:

```
~/.opencode2dsh/adapter-status.json
```

```json
{
  "status": "ready",
  "total": 64,
  "exposed": 9,
  "lastError": "",
  "writtenAt": "2026-08-29T07:01:54.915Z"
}
```

| Symptom | Likely cause and fix |
|---|---|
| Only 3 models appear | The first catalog fetch raced your network. Retries land within about a minute; check `lastError` in the status file. |
| `lastError: "fetch failed"` persists | Outbound HTTPS to `opencode.ai` is blocked. Check your proxy or VPN rules. |
| Rate-limit errors while chatting | The anonymous lane is quota-per-IP. Turn the pool on, add exits, or switch network node. |
| A model reports `REGION_BLOCKED` | Zen rejected the current network region for that model. The exit pool treats it as an exit-and-model ban, so other models keep working on it. |
| Every provider fails with `routing dispatcher closed` | The exit routing layer outlived the plugin. Restart the profile. |
| A manual entry shows healthy but never populates its exit IP | The address already carries a scheme. Use `http://host:port` or `socks5://host:port` exactly once. |
| Encrypted subscription nodes never get admitted | sing-box is not installed or not on PATH. Set `ipPool.singbox.path`. |
| Install fails with `ERR_PNPM_IGNORED_BUILDS` | Transitive dependencies of `pi-ai` have build scripts that are not needed at runtime. Set both to `false` under `allowBuilds:` in the profile's `pnpm-workspace.yaml`. |

## Security

- **No secret is involved.** The free lane's key is the literal string `public`. Nothing is stored and nothing is telemetrised.
- **Requests leave your machine directly**, to `opencode.ai` and `models.dev`, or through the proxy exits you configured.
- **Public free proxies are untrusted.** They can observe traffic. Use them for the free lane, which carries no credentials, and prefer your own nodes or a subscription for anything else.
- **Nothing installs a build script** from a dependency at install time.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build         # node bundle
pnpm run build:client  # browser bundle
```

`pnpm run verify:all` checks the published surface: that every entry point the manifest promises
exists, that the bundle patch installs the package the manifest names, that the row id matches the
plugin's own `name` export, and that the client bundle registers under the id the shell loader
expects. `pnpm run clean` removes `lib/` before a build, because the node build keeps its output
directory and a renamed module would otherwise leave its previous chunk behind.

The test suite covers the exit pool's selection order, cooldown and ban semantics, the bulk-paste
parser, and the built artifacts themselves: it imports `lib/`, walks the chunk graph to prove no
orphaned file ships, and builds a working pool from the bundled code. CI runs typecheck, the suite
and both structural checks on **Linux and Windows** on every push and pull request.

### Layout

```
src/
  adapter/      the Zen adapter: streaming, message shaping, request identity
  pool/         the exit pool: selection, health, probing, screening, routing
  ip-pool-settings/  the settings schema and the status bridge the page reads
  client/       the browser half: the IP pool page and its dictionaries
```

## Credits

This plugin descends from [opencode2dsh](https://github.com/FishBottle7/opencode2dsh) by
[@FishBottle7](https://github.com/FishBottle7), which is MIT licensed and remains the origin of the
catalog fallback chain, the request-disguise details and the anonymous-lane implementation. See
[NOTICE](NOTICE) for the full attribution.

- [OpenCode](https://opencode.ai), for running the free anonymous Zen lane.
- [models.dev](https://models.dev), for the model metadata that decides which models are free.
- [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai), the wire layer the
  adapter streams through.

## License

MIT, see [LICENSE](LICENSE).

Built by <a href="https://github.com/pazalo">Pazalo</a>.