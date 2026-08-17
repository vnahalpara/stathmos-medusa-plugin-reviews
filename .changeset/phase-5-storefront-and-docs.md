---
'@stathmos/medusa-plugin-reviews': minor
---

Add a Next.js storefront recipe, JSON-LD structured data, a
cache-revalidation recipe, and the full documentation set
(`docs/storefront-nextjs.md`, `docs/api-reference.md`, `docs/settings.md`,
`docs/seo-json-ld.md`, `docs/revalidation.md`).

**Helpful votes must be cast from the shopper's own browser, never a
Next.js `"use server"` action or other server-side wrapper.** The vote
route identifies a guest voter as `sha256(ip + user-agent + salt)`; routed
through a server action, every guest hands the backend the same server IP
and Node `fetch` user-agent, collapsing every guest into one
`voter_hash` — the first guest to vote gets a `201`, everyone else gets a
`409` forever, with no error logged anywhere. Proven with three simulated
shoppers voting through a throwaway server action: one database row, two
`409`s. On a deployment where an attacker's requests reach the backend
with the same source IP as the storefront (single-box, docker-compose,
shared NAT) the collapsed identity is also forgeable, letting an attacker
withdraw other shoppers' votes; on a split deployment with its own egress
IP it degrades to guest voting silently not working. Forwarding
`X-Forwarded-For` from a server action is explicitly rejected as a fix —
any client can set that header, making dedup trivially defeatable and
letting an attacker forge a chosen victim's hash.

Several additive events were added to close gaps found while building the
storefront that consumes them: `review.updated` also fires from the edit
workflow, `review.approved` also fires from `createReviewWorkflow`
alongside `review.created` when a `require_approval: false` store
auto-publishes, `review.media.curated`/`review.media.deleted` fire from
media curation and deletion, and `review.reply.created`/`review.reply.updated`
now carry `product_id` alongside `review_id` (previously `review_id`
only) with a new `review.reply.deleted` event covering a merchant
deleting a reply outright. A moderator resetting a review to `pending`
now correctly emits `review.updated` rather than a wrongly-fired
`review.rejected`. All additive, no schema change.

**`deleteReviewReplyStep`'s rollback now restores a deleted reply
verbatim (same id, same timestamps) instead of recreating it as a fresh
row.** This compensation path was inert until this release —
`deleteReviewReplyWorkflow` had only one step, so nothing downstream
could fail and trigger it — and the new `review.reply.deleted` event
above is what made it reachable: an event-bus failure now rolls the
delete back for real, on a merchant's actual reply.

**Known limitations, documented rather than fixed:** signed-in shoppers
are deduped as guests unless a host configures Medusa session auth on the
backend origin; there is no `voted_by_me` on the review list; review
ownership for the storefront's Edit control is tracked client-side in
`localStorage`; `helpful_count` is never revalidated by cache-invalidation
events; `thumbnail_url` is always `null` (no video poster generation yet);
and the gallery route's real worst-case cache staleness is ~360 seconds,
not the 60-second `s-maxage` figure alone. See
[docs/storefront-nextjs.md](../docs/storefront-nextjs.md#limitations-stated-plainly)
for the full reasoning behind each.
