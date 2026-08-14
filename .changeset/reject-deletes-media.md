---
'@stathmos/medusa-plugin-reviews': major
---

**Breaking:** rejecting a review now permanently deletes its media.
`POST /admin/reviews/:id/reject` and `POST /admin/reviews/batch/status`
(target status `rejected`) delete every file and `review_media` row
attached to a review the moment it is rejected — the stored file itself,
not just the database row — and this is irreversible. Approving a review,
or resetting one back to `pending`, still never touches media.

This reverses the original Phase 2 behaviour, which left a rejected
review's media in storage indefinitely and relied on
`DELETE /admin/reviews/media/:id` as the only, opt-in removal path. If you
built moderation tooling that assumed rejecting a review was safe to undo
without losing its photos and videos, that assumption no longer holds.

The status change always commits first; a failure while deleting one
review's media never reverts that review back to `pending` - it stays
rejected, the failure is logged, and any media left behind by the failure
is still reachable through `DELETE /admin/reviews/media/:id`. A batch
rejection deletes media for every review in the batch independently, so
one review's media-deletion failure does not stop the others from being
cleaned up.
