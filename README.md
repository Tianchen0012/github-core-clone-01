[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![Rank](https://make.fun/badge/github-core-clone-01/Tianchen0012/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![Reward](https://make.fun/badge/github-core-clone-01/Tianchen0012/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

# github-core-clone-01

A standalone, GitHub-compatible git forge in a single Node process — no git
binary, no database, no network beyond the trial environment. One in-memory
store backs all four surfaces:

- **Git smart HTTP** (`/{owner}/{repo}.git`): upload-pack protocol v2
  (advertisement, `ls-refs`, `fetch` with shallow/deepen) and receive-pack v0
  (push with packfile parsing, fast-forward-only ref updates, report-status).
  Packfiles are written undeltified and read with full OFS_DELTA / REF_DELTA
  resolution.
- **REST v3** (`/api/v3`): repositories, branches, commits, contents, labels,
  issues, comments, pull requests, squash merge.
- **GraphQL** (`/api/graphql`): repository/issue/pull-request queries,
  introspection for `Issue`, `PullRequest`, `Repository` and `SearchType`,
  `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` /
  `addComment` mutations, batched operations, cursor pagination.
- **MCP** (`/mcp`): JSON-RPC 2.0 over Streamable HTTP, modern 2026-07-28
  `server/discover` plus the legacy `initialize` handshake; six tools
  (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`).

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it at
`$MAKEFUN_ENV_URL/register`, serves until `$MAKEFUN_ENV_URL/done` reports
done, and exits 0. Node 22, standard library only.

## Layout

- `main.ts` — entrypoint and trial lifecycle
- `app.ts` — HTTP server and surface dispatch
- `store.ts` — the in-memory model (repos, refs, issues, PRs, git objects)
- `git.ts` — SHA-1 object ids, packfile read/write, pkt-line framing
- `gitproto.ts` — smart-HTTP protocol handlers
- `rest.ts` — REST v3 handlers
- `graphql.ts` — GraphQL parser and executor
- `mcp.ts` — MCP JSON-RPC handlers
- `util.ts` — request helpers

All stored data is deterministic: fixed author/committer identity and a fixed
epoch timestamp, so identical operations leave identical state.
