# Contributing

Thanks for considering a contribution.

## Getting set up

You need Node 20–24, PostgreSQL, and a Medusa v2 application to develop
against. If you do not have one:

```sh
npx create-medusa-app@latest my-test-host
```

Then, in this repo:

```sh
npm install
npm run dev        # watches and publishes to the local yalc registry
```

And in the host application:

```sh
npx medusa plugin:add @stathmos/medusa-plugin-reviews
npx medusa db:migrate
npx medusa develop
```

## Before opening a pull request

Run everything CI runs — all four must pass:

```sh
npm run lint
npm run typecheck
npm run build
npm test
```

CI additionally runs the integration suite against PostgreSQL on the two most
recent Medusa minors. A PR that only passes on the newest minor will fail.

## Changesets

Every PR that changes runtime behaviour needs a changeset:

```sh
npm run changeset
```

Pick `patch` for fixes, `minor` for new features, `major` for breaking changes.
Docs-only or CI-only changes do not need one.

## Conventions

- **Route handlers stay thin.** They validate input and invoke a workflow.
  Business logic belongs in workflows and the module service, never in a route.
- **Visibility is enforced in the service layer**, not per route. Media
  belonging to a review that is not approved must never be reachable from any
  store endpoint.
- **Settings are read through the settings cache**, never queried ad hoc, so
  invalidation stays correct across instances.
- New models need a migration generated with `npx medusa plugin:db:generate`.
- Add tests with behaviour changes. Prefer one assertion per unit test.

## Security

Please do not open public issues for security problems. Report them privately
via [GitHub security advisories](https://github.com/vnahalpara/stathmos-medusa-plugin-reviews/security/advisories/new)
instead.
