/**
 * Event-emission assertions for HTTP suites.
 *
 * Generalises the local `replyEventNames` helper admin-reply.spec.ts
 * introduced in Phase 3, which asserted on names alone. The revalidation
 * events (Phase 5) are only useful if their PAYLOAD carries the product a
 * subscriber has to invalidate, so this returns whole `{ name, data }`
 * messages rather than just names.
 *
 * Three details that are not obvious and that a hand-rolled version keeps
 * getting wrong:
 *
 *   1. `emitEventStep` calls `eventBus.emit(message)` with `message`
 *      always an ARRAY of `{ name, data, ... }` objects (see
 *      @medusajs/core-flows/common/steps/emit-event.js), so the calls have
 *      to be flattened before anything can be read off them.
 *   2. The bus is shared. Test setup - creating an admin user, a customer,
 *      a publishable key, a product - emits its own unrelated events onto
 *      the same spy, so an unfiltered assertion is really asserting on
 *      whatever the harness happened to do that run.
 *   3. **The module emits events of its own, in the same namespace.**
 *      Medusa's module service auto-emits `<module>.<entity>.<action>` for
 *      every CRUD write, so writing a review_media row emits
 *      `review.review-media.updated` - which a naive `startsWith('review.')`
 *      filter picks up alongside this plugin's workflow events. That is
 *      why `filter` accepts an exact-name list: `['review.approved']` is
 *      unambiguous where `'review.'` is not. A prefix is still the right
 *      tool for a namespaced family with no module twin, e.g.
 *      `'review.reply.'` (the module's own is `review.review-reply.*`).
 *
 * Usage:
 *
 *   const emitSpy = jest.spyOn(getContainer().resolve(Modules.EVENT_BUS), 'emit')
 *   ... do the thing ...
 *   expect(emittedEvents(emitSpy, ['review.created', 'review.approved'])).toEqual([
 *     { name: 'review.created', data: { id: expect.any(String) } },
 *   ])
 *
 * Assert on the whole returned array rather than `toContainEqual`: an
 * event that fires when it should not is exactly as much of a bug as one
 * that never fires, and only an exact match catches both.
 *
 * Restore the spy in an `afterEach` (`jest.restoreAllMocks()`), or the
 * bus stays spied for the rest of the file.
 */
export type EmittedEvent = { name: string; data: unknown }

/**
 * Every event this plugin's WORKFLOWS emit, and nothing else - pass it as
 * the filter to assert on "what the plugin announced" without having to
 * name the handful relevant to one test.
 *
 * Kept exhaustive on purpose: a suite filtering on this list fails when a
 * new event starts firing somewhere it should not, which is the whole
 * reason to assert on emissions at all. Adding an event to the plugin
 * means adding it here.
 *
 * Deliberately excludes the module service's automatic CRUD events
 * (`review.review.created`, `review.review-media.updated`, ...): those
 * follow every write, say nothing about intent, and would drown the
 * assertions.
 */
export const REVIEW_WORKFLOW_EVENTS = [
  'review.created',
  'review.approved',
  'review.rejected',
  'review.updated',
  'review.media.curated',
  'review.media.deleted',
  'review.reply.created',
  'review.reply.updated',
  'review.settings.updated',
]

export function emittedEvents(
  emitSpy: jest.SpyInstance,
  filter: string | string[]
): EmittedEvent[] {
  const matches = Array.isArray(filter)
    ? (name: string) => filter.includes(name)
    : (name: string) => name.startsWith(filter)

  return emitSpy.mock.calls
    .flatMap(([messages]) => (Array.isArray(messages) ? messages : [messages]))
    .map((message) => message as EmittedEvent)
    .filter((message) => typeof message?.name === 'string' && matches(message.name))
    .map(({ name, data }) => ({ name, data }))
}

export function emittedEventNames(
  emitSpy: jest.SpyInstance,
  filter: string | string[]
): string[] {
  return emittedEvents(emitSpy, filter).map((event) => event.name)
}
