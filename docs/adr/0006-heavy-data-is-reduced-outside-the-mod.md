# Heavy data is reduced outside the mod

All mods share one small script heap, and once it is exhausted every mod in the window breaks until the app restarts. Fetching models.dev's 6.6 MB `api.json` inside a mod did exactly that. So a mod never `fetch`es or `JSON.parse`s megabytes: it runs `exec` (curl piped to jq) to write a reduced file such as `models.json`, and reads only that. The same applies to git history (the Git mod streams a bounded number of commits and caches by ref, rather than reading whole histories).

**Consequences:** new data-loading mods are tried on small input first. Recovering a broken window needs the person's go-ahead to quit and reopen Herdr.

**Note (ADR 0011):** the Git mod example now lives on the `lazygit-mod` branch; the rule holds for every mod on `main`.
