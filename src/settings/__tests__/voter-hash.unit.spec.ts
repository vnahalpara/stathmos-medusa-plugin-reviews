import { voterHash } from '../voter-hash'

describe('voterHash', () => {
  it('is stable for the same inputs', () => {
    expect(voterHash('1.2.3.4', 'UA', 's')).toEqual(voterHash('1.2.3.4', 'UA', 's'))
  })
  it('changes with the salt, so hashes are not comparable across stores', () => {
    expect(voterHash('1.2.3.4', 'UA', 'a')).not.toEqual(voterHash('1.2.3.4', 'UA', 'b'))
  })
  it('changes with the IP and with the user agent independently', () => {
    const base = voterHash('1.2.3.4', 'UA', 's')
    expect(voterHash('5.6.7.8', 'UA', 's')).not.toEqual(base)
    expect(voterHash('1.2.3.4', 'other', 's')).not.toEqual(base)
  })
  it('never returns the raw inputs', () => {
    const h = voterHash('1.2.3.4', 'UA', 's')
    expect(h).not.toContain('1.2.3.4')
    expect(h).not.toContain('UA')
  })
  it('does not let field boundaries collide across ip and user agent', () => {
    // If ip/ua/salt were joined with a delimiter that can legally appear
    // inside an IP address (e.g. '.'), ('1.2', '3.4') and ('1.2.3', '4')
    // would concatenate to the same string and hash identically. Neither
    // '.' nor ':' can be trusted as a joiner for exactly this reason.
    expect(voterHash('1.2', '3.4', 's')).not.toEqual(voterHash('1.2.3', '4', 's'))
  })
  it('throws rather than silently hashing without a salt', () => {
    expect(() => voterHash('1.2.3.4', 'UA', '')).toThrow()
    // @ts-expect-error - exercising the runtime guard for a caller that
    // bypasses the type system (e.g. an untyped config value at runtime).
    expect(() => voterHash('1.2.3.4', 'UA', undefined)).toThrow()
  })
})
