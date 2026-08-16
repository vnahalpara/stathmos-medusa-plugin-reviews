---
'@stathmos/medusa-plugin-reviews': minor
---

Add helpful votes, the customer media gallery API, gallery curation, and
review editing.

`review_vote` dedupes a signed-in customer by `customer_id` and a guest by
`voter_hash` (`sha256(ip + user-agent + salt)`) through two disjoint
partial unique indexes in Postgres, not application code.
`POST`/`DELETE /store/reviews/:id/vote` cast and withdraw a vote on an
approved review; a duplicate vote from the same identity is a 409, and
`helpful_count` is maintained by a single atomic `UPDATE ... increment`.
Guest dedup is best-effort and defeatable by rotating IP address and user
agent — shipped anyway because customer-only voting is close to useless on
a storefront where most traffic reading reviews is anonymous, with Phase
6's per-endpoint rate limiting the actual cost-of-abuse control. The salt
is an operator-level secret configured via this plugin's `voteSalt` option
or the `REVIEW_VOTE_SALT` environment variable (plugin option wins; an
empty-string option counts as unset), deliberately not a merchant-editable
setting, with no default — a store that never configures it gets a loud
failure rather than a silently degraded, cross-installation-comparable
hash. `voter_hash` is pseudonymous personal data under GDPR.

`GET /store/reviews/gallery` returns media from approved, non-hidden
reviews, product-scoped or global, filterable by `type`, paginated with
`limit` (default 20, capped at 100) and `offset`, ordered pinned media
first then newest, and gated by the `gallery_enabled` setting. Approval
and visibility are re-derived from a live join against `review`, never
trusted from the request. Responses carry
`Cache-Control: public, max-age=0, s-maxage=60,
stale-while-revalidate=300` for a shared cache/CDN.
`POST /admin/reviews/media/:id/curation` (`{ pinned?, hidden? }`, at least
one required) pins media to lead the gallery ordering, or hides it from
the gallery and from store-facing review media without deleting the file
— the reversible counterpart to `DELETE /admin/reviews/media/:id` — and is
also available from the admin media lightbox.

`POST /store/reviews/:id` (`{ rating?, title?, content? }`, at least one
required) lets a signed-in customer edit their own review. A guest
submission has no account to prove ownership, so guests are refused with
an explanatory 403, never a bare 401; editing someone else's review is
refused the same way. Under `require_approval: true`, an edit returns the
review to `pending` and the product's rating summary is recomputed to
exclude it in the same request. Editing a `rejected` review always lands
in `pending`, even when `require_approval` is `false`, since a rejection
is a specific moderator judgment that a store-wide auto-approval policy
must never be allowed to silently overturn. `title: null` clears a title,
media survives an edit, and `edited_at` is set.

**`allow_edit` now defaults to `true` — but only for a fresh install that
has never saved a settings row** (it shipped `false`, and non-interactive
in the settings UI, in Phases 1–3 specifically because the edit flow did
not exist yet). A store that saved settings at any point before this
release keeps its stored `false` and must switch `allow_edit` on itself in
Settings → Reviews; this is the safe outcome, since it means the riskier
`allow_edit: true` + `require_approval: false` pairing can never appear
silently on upgrade. **`gallery_enabled` now actually gates**
`GET /store/reviews/gallery`, where in Phases 1–3 it existed in the
settings schema but affected nothing.

**Known limitation:** guest vote de-duplication is best-effort, not
tamper-proof, and there is no rate limiting on the vote endpoint until
Phase 6 — see the README's [Helpful votes](README.md#helpful-votes)
section.
