/**
 * How long an uploaded file may sit unattached before it is swept. Long
 * enough that a shopper can upload photos, wander off to write their review
 * and come back; short enough that abandoned forms do not accumulate.
 */
export const ORPHAN_TTL_HOURS = 24

export function orphanCutoff(now: Date): Date {
  return new Date(now.getTime() - ORPHAN_TTL_HOURS * 60 * 60 * 1000)
}
