# Building and testing

Building the binaries yourself, and running the test suite.

Requires Node.js 22 or newer. After running `npm install`, `npm run build` produces standalone binaries in `build/`:

| Target | Script |
| --- | --- |
| Windows x64 | `npm run build:win:x64` |
| macOS x64 | `npm run build:macos:x64` |
| Linux x64 | `npm run build:linux:x64` |
| Linux arm64 | `npm run build:linux:arm64` |
| macOS arm64 | `npm run build:macos:arm64` (not in `npm run build`, see below) |

The binaries bundle Node 26 and are produced with [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg), the maintained fork of the archived `vercel/pkg`. The original `pkg` only supported up to Node 18, which is end of life, and carried an unpatched privilege-escalation advisory.

Two cross-compilation caveats:

- **arm64 targets are built without V8 bytecode** (`--no-bytecode --public`). Generating bytecode requires *executing* the target binary, which an x64 host cannot do for arm64. The source is therefore readable inside those binaries.
- **macOS arm64 is excluded from `npm run build`.** Apple Silicon refuses to launch an unsigned binary, and signing cannot be done from Windows or Linux without `ldid`. Build it, then on a Mac run `codesign --sign - PlexIPTV.macos.arm64`.

Dependencies are locked with `package-lock.json`; the old `yarn.lock` was dropped so there is a single lockfile.

## Tests

```bash
npm test
```

Runs the suite with the built-in Node test runner, no test framework dependency. `npm run lint` checks style, and `npm run audit:prod` audits the dependencies that actually ship.

## Commit messages

Each commit, and each pull request title, starts with a type saying what kind of change it is:

```
fix: look for the DejaVu font where Alpine installs it
feat(dashboard): show the source of each channel
```

The types are `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `security`, `ci`, `build`, `chore`, `style` and `revert`. A scope in brackets is optional, and `!` after the type or scope marks a breaking change. The subject has no full stop, the whole line is at most 100 characters, and a body, if there is one, comes after a blank line. Merge and revert commits that git writes itself are left alone.

Pull requests are checked by the Commit messages workflow. To check your branch before pushing:

```bash
npm run lint:commits
```

Or have git check each commit as you make it:

```bash
git config core.hooksPath .githooks
```
