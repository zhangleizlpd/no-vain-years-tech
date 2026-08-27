# Local Dev / Manual-Test Runbook — server + mobile web + real device

> **前置**：本文命令块里的 `$NVY_*` 从仓外解析 —— 本机跑先 `. ~/.nvy/fleet.env`，主机上跑先 `. /etc/nvy-fleet.env`。变量清单与角色说明见 [`ops/host/fleet.env.example`](../host/fleet.env.example)；为什么真值不入库见 [`information-boundary.md`](../../docs/conventions/information-boundary.md)。

Hands-on procedure to bring the full stack up on a dev machine for **manual
testing**: Postgres + Redis (docker) → NestJS server (`localhost:3000`) → Expo
Web (`localhost:8081`). **One server set serves both clients**: a browser via
Expo Web, and a real Android device (Mate50) running a dev client against the
**same** local server (see [§ Real device](#real-device-mate50--dev-client-on-the-same-local-server)).
Dev deps topology: [`docker-compose.dev.yml`](../../docker-compose.dev.yml)
(ports 5433/6380, project `mbw-poc`, deliberately offset from prod/meta to avoid
collision). For production deploy see [`prod-deploy-rollback.md`](./prod-deploy-rollback.md).

> All commands run from the **mono root**
> (`no-vain-years-mono/`) unless noted. Ports used: 5433 (PG), 6380 (Redis),
> 3000 (server), 8081 (Expo web).
>
> **⚠️ In a per-feature git worktree the ports + env differ — this whole runbook
> assumes the mono root.** A worktree (`feat-open`, see
> [`.claude/skills/mono-worktree/SKILL.md`](../../.claude/skills/mono-worktree/SKILL.md))
> isolates **server PORT (3001+) / Metro (8082+) / Redis db (1+)** via its root
> `.envrc`; PG `mbw_poc` stays shared. Three things bite if you follow the
> mono-root steps verbatim:
>
> 1. **Don't create `apps/server/.env`.** The worktree `.envrc` already `source`s
>    the **main repo's** `apps/server/.env` (real secrets) and then overrides
>    `PORT` / `EXPO_METRO_PORT` / `REDIS_URL`. A local copy is redundant and only
>    breeds "which .env has the real tokens" confusion. Skip Prereq 3.
> 2. **`nx serve server` is fine as-is** — direnv injects `PORT=3001`, the server
>    reads it automatically. (Confirm with the running log's `running on:` line,
>    not a hard-coded `:3000`.)
> 3. **Metro + web need two manual flags** — Expo does **not** read
>    `EXPO_METRO_PORT`, and the web client's API base defaults to
>    `http://localhost:3000` (`setup.ts`), not the worktree's `3001`. So launch
>    web as (substitute your worktree's allocated ports):
>
>    ```bash
>    EXPO_PUBLIC_API_BASE_URL=http://localhost:$PORT \
>      nx serve mobile -- --web --port $EXPO_METRO_PORT   # e.g. 3001 / 8082
>    ```
>
> Then open `http://localhost:<EXPO_METRO_PORT>` (e.g. `:8082`), not `:8081`.

## Prereqs (one-time)

1. **Docker** running (OrbStack / Docker Desktop) — provides PG + Redis.
2. **Deps installed**: `pnpm install` (Node `^22`, pnpm `>=10 <11`).
3. **Server env**: `apps/server/.env` exists. If missing, copy from
   `apps/server/.env.example` and keep the dev defaults:
   - `DATABASE_URL="postgresql://mbw:mbw@localhost:5433/mbw_poc"`
   - `REDIS_URL="redis://localhost:6380"`
   - `SMS_GATEWAY="mock"` — **no real SMS sent**; the login code is written to
     the server log (see § Manual test).
4. **Mobile** needs no env for web: it defaults `baseURL` to `http://localhost:3000`
   when `EXPO_PUBLIC_API_BASE_URL` is unset (`apps/mobile/src/core/api/setup.ts`).

## Bring-up steps

### 1. Start deps (Postgres + Redis)

```bash
docker compose -f docker-compose.dev.yml up -d
docker compose -f docker-compose.dev.yml ps   # both should be (healthy)
```

### 2. Apply DB schema

```bash
pnpm -C apps/server exec prisma migrate status   # expect "Database schema is up to date!"
# if migrations are pending on a fresh volume:
pnpm -C apps/server exec prisma migrate deploy
```

### 3. Start the server (build + watch)

```bash
npx nx serve server      # runs build, then `node --watch dist/main.js`
```

Ready when the log prints `🚀 Application is running on: http://localhost:3000/api`.
Verify:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/healthz/live   # 200
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/docs           # 200 (OpenAPI UI)
```

> Routes carry global prefix `/api` (e.g. `/api/v1/...`), **except** health
> (`/healthz/live`, `/healthz/ready`) which is excluded from the prefix.

### 4. Start mobile (Expo Web)

```bash
npx nx run mobile:serve --args="--web"   # or: pnpm -C apps/mobile web
```

First bundle is slow (Metro compiles the dep graph). Ready when it logs
`Waiting on http://localhost:8081`. Open <http://localhost:8081> in a browser.

> Both commands carry `EXPO_PUBLIC_FEATURE_MARKETS=true` (the `serve` target +
> the `web` script), so markets / 投资 / 预警 surface in dev. The flag defaults
> **fail-safe OFF** (per `apps/mobile/src/core/feature-flags.ts`) — a bare
> `expo start --web` (no env) launches with markets hidden. Use the commands
> above, not raw `expo start`.

| Target                       | API connectivity        | Notes                                                                                                                                                                                     |
| ---------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expo Web                     | `localhost:3000` direct | zero extra config                                                                                                                                                                         |
| iOS simulator                | `localhost:3000` direct | shares the Mac network; dev client needs full Xcode — see [§ iOS Simulator](#ios-simulator--dev-client-on-the-same-local-server)                                                          |
| physical device (dev client) | **needs LAN IP**        | jpush native dep ⇒ **no Expo Go**; both Metro (8081) and API (3000) must use the Mac LAN IP. Full procedure in [§ Real device](#real-device-mate50--dev-client-on-the-same-local-server). |

## Real device (Mate50) — dev client on the same local server

Run the app on a physical Android device against the **same** local server from
steps 1-3 — real DB writes to the dev Postgres (5433), login codes still go to
the server log (`SMS_GATEWAY=mock`). This is the native counterpart to Expo Web;
deps + server are shared, only the client differs.

> **Why a dev client, not Expo Go**: `jpush-react-native` is a native dependency
> (config plugin `apps/mobile/plugins/with-jpush.js`), so Expo Go can't load this
> app — you need a **development build** (dev client). See
> [`docs/private/plans/2026-06/06-11-mac-mobile-device-verification.md`](../../docs/private/plans/2026-06/06-11-mac-mobile-device-verification.md)
> for the full simulator/device landscape.

**No Android emulator needed for daily work.** For this app — China-targeted, no
GMS, jpush vendor-channel push — the Mate50 (real Huawei, no Google services) is
the _more_ representative target, and vendor-channel push only verifies on a real
device. An emulator earns its keep only for multi-screen / multi-Android-version
layout checks or headless CI E2E (Maestro, Plan 4 — where Maestro Cloud / a device
farm is an alternative anyway); install Android Studio + SDK + AVD only when you
hit one of those. (Android-only call — the iOS Simulator stays the only way to see
iOS without an iOS device.)

### Two connections — both must use the Mac LAN IP

A real device is not the Mac, so `localhost` resolves to the **phone**. Both
links have to point at the Mac's LAN IP (find it: `ipconfig getifaddr en0`):

| Link                | What                                                                     | Default pitfall                     | Fix                                                                                     |
| ------------------- | ------------------------------------------------------------------------ | ----------------------------------- | --------------------------------------------------------------------------------------- |
| ① Metro (JS bundle) | dev-client APK ships no JS; pulls the bundle from Metro (8081) at launch | phone can't reach `localhost:8081`  | same Wi-Fi ⇒ connects to `<mac-lan-ip>:8081` (auto-discovered, or scan QR / `--tunnel`) |
| ② API (backend)     | app HTTP calls hit the server (3000)                                     | `localhost:3000` = the phone itself | set `EXPO_PUBLIC_API_BASE_URL=http://<mac-lan-ip>:3000`                                 |

Prereqs (verified once): phone on the **same Wi-Fi subnet** as the Mac; server
listens on `0.0.0.0` (`apps/server/src/main.ts`, already does); macOS Application
Firewall off or allowing `node` (else it blocks inbound from the phone).

### Get & install the dev client (the only EAS step)

The dev-client APK is a thin native shell (native layer + jpush + Metro loader);
it carries **no** business JS — JS comes from Metro at launch. Install it once and
only re-install a **fresh build when the native layer changes** (new native dep,
`app.json` plugin, native config, Expo SDK / RN bump — see the rebuild table
below). Zero local Android SDK needed; `adb` is enough to install.

> The `development` profile builds **`arm64-v8a` only** — the Mate50 (and every
> modern phone) is arm64, so the dev-client APK is slimmed to a single ABI for
> faster cloud builds + smaller download (`apps/mobile/plugins/with-android-abi.js`,
> gated on `EAS_BUILD_PROFILE`). `preview` / `production` stay universal (all four
> ABIs). To dev-build for a non-arm64 device, lift the restriction there.

**Don't blindly grab "the latest build" — it must match TWO things or the app
crashes on launch:**

| Must match                       | Why                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **profile = `development`**      | only `development` sets `developmentClient:true` (connects to Metro + hot reload) and leaves the API base **unbaked** (taken from the `expo start` env). `preview` / `production` bake `EXPO_PUBLIC_API_BASE_URL=https://api.shintongtech.com` and ship **no** dev-client — they run standalone against **prod**, never your local server (`eas.json`). |
| **commit ⊇ current native deps** | a dev build from a commit _before_ a native dep landed lacks that native module → app crashes at launch with `'<pkg>' doesn't seem to be linked` / `Cannot find native module '<X>'`. The APK's native surface must cover every native dep in the JS Metro will serve.                                                                                  |

Reuse an existing build when one qualifies; only `eas build` fresh when none does
(e.g. you just added a native dep):

```bash
cd apps/mobile
# find the newest *development* build whose Commit already includes your native deps:
pnpm exec eas build:list --platform android --profile development --limit 5
pnpm exec eas build:view <id>   # confirm Status=finished, Profile=development, Commit ⊇ deps
# none qualifies? build fresh from HEAD (~10-20 min cloud + queue wait):
pnpm exec eas build -p android --profile development --non-interactive
```

Download the artifact `.apk` and install over USB. The APK is large (~220 MB) and
the expo CDN over a CN proxy **truncates mid-stream** — a partial download
installs-fails with `INSTALL_PARSE_FAILED_NOT_APK`. Use a **resume loop**, not a
single curl (`--retry` restarts from zero; `-C -` resumes):

```bash
URL="<Application Archive URL from build:view>"
cd /tmp && for n in $(seq 1 40); do
  unzip -t devclient.apk >/dev/null 2>&1 && { echo "valid"; break; }   # full zip → done
  curl -fL -C - --connect-timeout 20 --max-time 120 -o devclient.apk "$URL"
done
adb devices                       # phone shows as `device` (not `unauthorized`)
adb install -r /tmp/devclient.apk # appId com.shintongtech.novainyears
```

> Phone setup: Developer options on (tap Build number ×7) → enable **USB
> debugging** + **USB install** → plug in → tap **Allow** on the phone. On Huawei
> / HarmonyOS, `adb install` then **blocks waiting for an on-screen "Install"
> confirmation** — watch the phone and tap it (the command is not hung).

### Local Gradle build — the EAS-free alternative

When EAS quota is exhausted (or you just want a faster, offline iteration), build
the dev-client APK **locally** with Gradle instead of the cloud. The Expo project
is CNG/managed, so `android/` is a prebuild output; the **`debug` build type is the
dev-client** (`expo-dev-client` wires the debug variant to the Metro launcher —
`developmentClient` + unbaked API base, same role as the EAS `development`
profile). One-time toolchain setup (Android SDK + JDK 17) is **machine-specific**
(`brew --cask android-commandlinetools` + `sdkman java 17`); the build itself:

```bash
JAVA_HOME=~/.sdkman/candidates/java/17.0.19-tem \
ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
  apps/mobile/android/gradlew -p apps/mobile/android assembleDebug
# artifact: apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk (~245 MB)
```

RN 0.81 needs **JDK 17** (not the system-default 21 — `JAVA_HOME` above overrides
it just for this build). The first build compiles the NDK layer (nitro / reanimated)
~28 min; once `.cxx` is cached, incremental builds are ~2-3 min. The APK never leaves
the machine, so there's **no CN-proxy truncation** — skip the curl resume loop and
install straight away:

```bash
adb uninstall com.shintongtech.novainyears   # local debug keystore ≠ a prior EAS sig → uninstall first, else INSTALL_FAILED_ABORTED ("User rejected permissions" — misleading, it's the signature)
adb install apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

> Reinstall over a prior **local** build (same debug keystore) works with
> `adb install -r`, no uninstall. Only a keystore change (EAS → local, or A → B)
> forces the uninstall.

**When to rebuild** is the same trigger as the EAS path: native dep / `app.json`
plugin / native config / Expo SDK·RN bump. JS/TS changes never need a rebuild — hot
reload. **Gotcha specific to a just-added native dep**: once the dep lands in
`node_modules`, a Metro that was **already running** (even one started with
`--clear`) won't index it — the app then errors `UnableToResolveError: Unable to
resolve module <new-pkg>` at launch. Fix = **restart Metro fresh** (kill the running
one; `--clear` at start is not enough once it's already up). The rebuilt APK _and_ a
fresh Metro both have to cover the new native surface. Confirm the dep autolinked into
the APK with `grep -ri <pkg> apps/mobile/android/app/build/generated/autolinking/`.

### Daily loop — hot reload, no EAS

After the APK is installed, **everyday development never touches EAS**. Start
Metro from the mono root with the API base pointed at the Mac LAN IP:

```bash
EXPO_PUBLIC_API_BASE_URL=http://<mac-lan-ip>:3000 \
  pnpm -C apps/mobile exec expo start --dev-client
```

Open the installed dev-client app on the Mate50 → it connects to Metro → edit
JS/TS and save → **Fast Refresh** pushes the new bundle in milliseconds (state
preserved). Press `r` in the terminal (or shake the phone) for a full reload.

> **Scriptable launch + connect** (no tapping): cold-launch first, _then_ fire
> the connect deep link at the Mac LAN IP — a cold start swallows the first deep
> link (same gotcha as the iOS sim):
>
> ```bash
> adb shell monkey -p com.shintongtech.novainyears -c android.intent.category.LAUNCHER 1
> sleep 5   # let it cold-start
> adb shell am start -a android.intent.action.VIEW \
>   -d "nvy://expo-development-client/?url=http%3A%2F%2F<mac-lan-ip>%3A8081"
> ```
>
> After **re-installing a new APK**, `monkey`/launcher only foregrounds the
> already-running (possibly crashed) process — it won't pick up the new native
> layer. `adb shell am force-stop com.shintongtech.novainyears` first, then
> cold-launch, so it re-evaluates the bundle against the new APK.

What needs a **rebuild** vs what hot-reloads:

| Change                                                                                | Rebuild APK?                  |
| ------------------------------------------------------------------------------------- | ----------------------------- |
| JS/TS code, styles, components, assets, **pure-JS** deps                              | ❌ hot reload                 |
| Native dependency, `app.json` plugins, native config (e.g. jpush), Expo SDK / RN bump | ✅ re-run the EAS build above |

> **`EXPO_PUBLIC_*` is inlined at bundle time**, not read at runtime — Metro
> bakes it into the bundle when it starts, and hot reload reuses that value. So
> the env on the `expo start` line sticks for the whole session; only **changing
> the backend address** requires Ctrl-C + restarting Metro. Editing app code
> never does.

### Drive a check hands-free + the "wrong APK" trap

**Wrong-build trap** — if the phone has a **non-dev-client** APK installed (a
`preview` / `internal` / `production` build, or a stale dev-client), it silently
runs its **embedded JS** and ignores Metro: your edits never show, and a bug you
think you fixed still reproduces (you're verifying old code). Confirm _which_ build
you have before debugging anything:

| Check                                                                   | dev-client (right)                       | standalone (wrong)       |
| ----------------------------------------------------------------------- | ---------------------------------------- | ------------------------ |
| `adb shell dumpsys package com.shintongtech.novainyears \| grep flags=` | flags include **`DEBUGGABLE`**           | no `DEBUGGABLE`          |
| Metro log right after launching the app                                 | `Android Bundled … entry.js` (a request) | **nothing** (0 requests) |
| editing JS                                                              | Fast Refresh updates the screen          | UI never changes         |

Fix = install the `development`-profile APK (above). `adb install -r` over a
standalone works only if same keystore, else `adb uninstall` first.

**USB tunnel instead of LAN IP** — if the phone can't reach the Mac over Wi-Fi
(different subnet / firewall), skip the LAN-IP env and tunnel over USB:
`adb reverse tcp:8081 tcp:8081 && adb reverse tcp:3000 tcp:3000`, then start Metro
with **no** `EXPO_PUBLIC_API_BASE_URL` (the bundle falls back to `localhost:3000`,
which the reverse maps to the Mac). The dev-client launcher then lists
`http://localhost:8081` with a green dot (= reachable) — tap it to load the bundle.

**Drive the UI from the terminal** (agent / no hands) — `monkey` + the connect deep
link only get you _to_ Metro; to tap precisely, read the live view tree instead of
guessing pixels:

```bash
adb shell uiautomator dump /sdcard/u.xml && adb pull /sdcard/u.xml /tmp/u.xml
# grep the target's content-desc / text → bounds="[x1,y1][x2,y2]" → tap its centre:
adb shell input tap <cx> <cy>
adb exec-out screencap -p > /tmp/s.png   # then view the PNG
```

Footguns: tabs / buttons in the bottom **gesture zone** (y > ~2292 on a 1088×2400
panel) fire Back/Home instead of the control — tap the element's real `bounds`, not
a guessed bottom-edge y. When the **soft keyboard is up the input bar shifts up**
(KeyboardAvoidingView), so re-`uiautomator dump` for the new coordinates before
tapping. To land on a deep feature screen directly — and **bypass a crashing
list/tab on the way** — deep-link the route instead of navigating:
`adb shell am start -a android.intent.action.VIEW -d "nvy:///ideation/<id>" com.shintongtech.novainyears`
(Expo Router hides the `(app)` group in the path; grab an `<id>` from the dev DB).
The chat **input-bar chrome renders even if the session id isn't the logged-in
account's** (the fetch just returns empty), so any valid `<id>` is enough to verify
input-composer UI.

## iOS Simulator — dev client on the same local server

The iOS counterpart of the Mate50 path. The simulator shares the Mac's network,
so it's actually simpler than the real device — `localhost` reaches the server
and Metro directly. One catch: **full Xcode is mandatory** (the simulator runtime
lives inside Xcode; Command Line Tools alone can't run a simulator).

### One-time — Xcode + runtime + dev-client build

**Full Xcode** (App Store), then settle the CLI:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -license accept
sudo xcodebuild -runFirstLaunch
```

**iOS Simulator runtime** — Xcode ▸ Settings ▸ Platforms ▸ get "iOS <ver>" (~8 GB),
or `xcodebuild -downloadPlatform iOS`. (Skip the "Predictive Code Completion Model"
— Xcode's Swift autocomplete, unused here.) Verify `xcrun simctl list runtimes`
shows an iOS entry.

**Cloud-build the simulator dev client** (no CocoaPods / no local compile) — the
artifact is a `.tar.gz` wrapping the `.app`:

```bash
cd apps/mobile && eas build -p ios --profile development   # profile has "simulator": true
# download the artifact, then verify integrity + unpack:
curl -fL -o app.tar.gz "<applicationArchiveUrl>" && gzip -t app.tar.gz   # truncated → "truncated gzip input"
tar -xzf app.tar.gz   # yields *.app
```

### Daily loop — boot, install, connect (hot reload, no EAS)

```bash
xcrun simctl boot "iPhone 17 Pro" && open -a Simulator   # any installed iPhone device
xcrun simctl install booted /path/to/app.app
xcrun simctl launch booted com.shintongtech.novainyears
# connect to Metro (cold launch swallows the first deep link — launch first, then fire this):
xcrun simctl openurl booted "nvy://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"
```

Start Metro the same way as the Mate50 path. **One Metro (8081) serves Web +
Mate50 + iOS Simulator at once** — the iOS sim, being on the Mac, also reaches the
Mate50's `EXPO_PUBLIC_API_BASE_URL=http://<mac-lan-ip>:3000` fine (the Mac can hit
its own LAN IP), so no separate Metro is needed. Edit JS/TS → Fast Refresh.

| Gotcha                               | Note                                                                                                                              |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| full Xcode mandatory                 | simulator runtime is part of Xcode; CLT-only can't run a sim                                                                      |
| EAS iOS sim artifact                 | a `.tar.gz` wrapping the `.app` — `tar -xzf` it; verify `gzip -t` (truncated download → `truncated gzip input`)                   |
| cold-launch swallows first deep link | same as Android — `simctl launch` first, then `simctl openurl` the dev-client URL (re-fire once if Metro shows no `iOS Bundling`) |
| API base                             | sim shares the Mac, so `localhost:3000` works; if Metro carries the Mate50 LAN-IP env, the sim uses that too — both fine          |

## Manual test — getting the login SMS code

`SMS_GATEWAY=mock` means `MockSmsGateway` (`apps/server/src/auth/mock-sms.gateway.ts`)
does not send a real SMS — it logs the code instead. After requesting a code in
the app, grab it from the server log:

```text
[MOCK SMS] sent <code> to <phone> (purpose=login)
```

If the server runs in a terminal, the line is on stdout. If backgrounded to a
file, `grep "MOCK SMS" <logfile> | tail -1`.

## Optional — local real code-index (ideation grounding 联调)

Default server uses the **fake** code-index provider (`CODE_INDEX_PROVIDER` unset →
deterministic hits, `apps/server/src/config/codeindex.config.ts`), so normal local
dev / IT / 契约冒烟 need **no** index service or tunnel. Only do the below when you
want to exercise **real** grounding hits against the 62 (`mbw-indexer`) index.

62's query API (`:7700`) is firewalled from the public internet (prod reaches it via
the WireGuard 62↔77 tunnel — see [`code-index-tunnel.md`](./code-index-tunnel.md)).
The Mac isn't on that mesh, so use an SSH local-forward as the equivalent:

```bash
# 1) tunnel: local :7700 → host `index` 的 code-index query API（真值取 $NVY_INDEX_SSH）
ssh -N -L 7700:localhost:7700 -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes mbw-indexer &

# 2) verify the tunnel (healthz needs no token)
curl -fsS localhost:7700/healthz   # {"ok":true}
```

Then set these in `apps/server/.env` (gitignored; the token lives **only** here, never
commit it — read it from 62's `/etc/code-index.env`, see [`code-index-deploy.md`](./code-index-deploy.md)):

```ini
CODE_INDEX_PROVIDER="http"
CODE_INDEX_URL="http://localhost:7700"
CODE_INDEX_SERVICE_TOKEN="<from 62 /etc/code-index.env — do NOT commit>"
```

Restart the server (`nx serve server` reloads `.env`) and grounding hits the real index.

> **⚠️ `http` in `.env` is a persistent default for _every_ `nx serve`.** Boot still
> succeeds with the tunnel down (Zod only validates url shape, not connectivity), but
> any ideation grounding `/search` then **errors/degrades at runtime** (per FR-008 it
> degrades to a notice bubble, not a crash). When done with grounding work, flip
> `CODE_INDEX_PROVIDER` back to `"fake"` or keep the tunnel up. Stop the tunnel with
> `pkill -f "ssh -N -L 7700"`.

## Teardown

Stopping interactive dev (server + expo/Metro, incl. the one the Mate50 connects to)
is independent from tearing down the shared dev DB — keep them separate:

```bash
# stop server + expo: Ctrl-C their terminals, or kill by port:
lsof -tnP -iTCP:3000 -sTCP:LISTEN | xargs -r kill -9
lsof -tnP -iTCP:8081 -sTCP:LISTEN | xargs -r kill -9
```

> **⚠️ Don't reflexively `compose down` the dev DB at "收工".** The `mbw-poc-postgres`
> stack is **shared** — the unattended **09:05 marketdata sync** (`com.nvy.marketdata-dev-sync`)
> depends on it. `compose down` _removes_ the containers (not just stops), so a next-morning
> sync would otherwise fail with "本地 dev PG 未就绪". The sync now **self-heals** (it runs
> `compose up -d` before its readiness probe — `scripts/marketdata-dev-sync/sync.sh` §0), so
> a stray `down` is no longer fatal; still, prefer leaving the DB up between sessions.

Only tear down the DB when you actually need to (reclaim resources / reset data):

```bash
docker compose -f docker-compose.dev.yml down      # stop deps, KEEP data (volumes)
docker compose -f docker-compose.dev.yml down -v    # ...or drop the PG volume too
```

`down` (no `-v`) preserves the `mbw-poc-pgdata` volume, so schema + seeded data
survive across restarts.

> **`nx serve` respawns port 3000.** Killing only the `:3000` PID leaves the
> `node --watch dist/main.js` parent (under `npm exec nx serve` / its launching
> shell) alive — `--watch` sees the port free up and restarts the server. To stop
> it for good, kill the whole tree, not just the listener:
>
> ```bash
> pkill -f "nx serve"; pkill -f "node --watch dist/main.js"
> # then confirm: lsof -tnP -iTCP:3000 -sTCP:LISTEN  → empty
> ```

## Claude Code plan 落点（主 / 副 worktree 汇到同一目录）

**判据 —— `plansDirectory` 只在「plans 目录的 realpath 落在本 worktree 内」时才生效。** 它校验时先 `realpath` 解析再比对（2026-08-09 于 Claude Code 2.1.222 二进制内实证），所以任何指向 worktree 之外的 symlink 都会让它失败、静默回退到默认的 `~/.claude/plans`，只在日志里留一条 `plansDirectory must be within project root`。

由此本仓的落点是**两条路、一个目录**：

|             | 走哪条                | 落点                                                                              |
| ----------- | --------------------- | --------------------------------------------------------------------------------- |
| 主 worktree | `plansDirectory` 生效 | `docs/private/plans/`                                                             |
| 副 worktree | 校验失败 → 回退默认   | `~/.claude/plans` → **dev 机把它 symlink 到主 worktree 的 `docs/private/plans/`** |

两条路最终写同一个 inode，因此不存在同步、冲突或归档延迟。副 worktree 的 `docs/private` 由 `feat-open` 建成指向主 worktree 的 symlink，读改已有 plan 也是同一个文件。

⚠️ `~/.claude/plans` 那条 symlink 在**仓外**，clone 本仓不会带上它；换机重装必须手工重建（`ln -s <主 worktree>/docs/private/plans ~/.claude/plans`），否则副 worktree 的 plan 会散落在 `~/.claude/plans` 真目录里。它同时意味着**其他项目**的 plan 也会落进本仓的 `docs/private/plans/` 根目录 —— 结构上可辨：根目录是 plan mode 自动落的草稿（随机 slug），`YYYY-MM/` 子目录才是归档的成品。

## Troubleshooting

| Symptom                                                                                        | Cause / fix                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| server 404 on `/api/healthz/...`                                                               | health is **not** under `/api`; use `/healthz/live`.                                                                                                                                                                                          |
| port 3000/8081/5433/6380 already in use                                                        | a prior run is still up; kill by port (see Teardown) or `docker compose ... ps`.                                                                                                                                                              |
| mobile can't reach API on a real device                                                        | `localhost` ≠ the Mac; set `EXPO_PUBLIC_API_BASE_URL` to the Mac LAN IP.                                                                                                                                                                      |
| `prisma migrate status` can't find schema                                                      | run via `pnpm -C apps/server` (cwd must be `apps/server`).                                                                                                                                                                                    |
| login never receives a code                                                                    | confirm `SMS_GATEWAY="mock"`; read the code from the server log, not a phone.                                                                                                                                                                 |
| dev client can't find / connect to Metro                                                       | phone + Mac must share a Wi-Fi subnet; macOS firewall must allow `node`; else use `npx expo start --dev-client --tunnel`.                                                                                                                     |
| changed `EXPO_PUBLIC_API_BASE_URL` but app still hits the old address                          | it's inlined at bundle time — Ctrl-C and restart Metro with the new value (hot reload alone won't pick it up).                                                                                                                                |
| changed JS but device doesn't update                                                           | confirm the dev-client app is connected to **this** Metro; press `r` to force reload; native changes need a rebuilt APK (see table above).                                                                                                    |
| app crashes on launch: `'<pkg>' doesn't seem to be linked` / `Cannot find native module '<X>'` | the installed dev-client APK predates a native dep in the JS Metro serves; JS hot reload can't deliver native code. Install a `development` build from a commit that includes the dep (rebuild if none) — see the profile/commit table above. |
| `adb install` → `INSTALL_PARSE_FAILED_NOT_APK`                                                 | truncated download (CN proxy dropped the ~220 MB stream); re-fetch with a `curl -C -` resume loop until `unzip -t` passes, then re-install.                                                                                                   |
| installed a new APK but app still crashes / runs old JS                                        | `monkey`/launcher only foregrounds the existing process; `adb shell am force-stop com.shintongtech.novainyears`, then cold-launch + re-fire the connect deep link.                                                                            |
| `adb: no devices/emulators found` after the phone sat idle                                     | screen-lock dropped the USB authorization; replug + unlock + tap **Allow**; if still missing, `adb kill-server && adb start-server`.                                                                                                          |
