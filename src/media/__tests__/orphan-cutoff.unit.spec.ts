import { ORPHAN_TTL_HOURS, orphanCutoff } from '../orphan-cutoff'

describe('orphanCutoff', () => {
  it('is TTL hours before the given time', () => {
    const now = new Date('2026-08-13T12:00:00.000Z')

    expect(orphanCutoff(now).toISOString()).toBe('2026-08-12T12:00:00.000Z')
  })

  it('uses a 24 hour window', () => {
    expect(ORPHAN_TTL_HOURS).toBe(24)
  })
})
