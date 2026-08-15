import { resolveVoteSalt } from '../vote-salt'

describe('resolveVoteSalt', () => {
  it('prefers a plugin-options salt over the environment variable', () => {
    expect(
      resolveVoteSalt(
        { voteSalt: 'from-options' },
        { REVIEW_VOTE_SALT: 'from-env' } as NodeJS.ProcessEnv
      )
    ).toEqual('from-options')
  })

  it('falls back to REVIEW_VOTE_SALT when options are not provided at all', () => {
    expect(
      resolveVoteSalt(undefined, { REVIEW_VOTE_SALT: 'from-env' } as NodeJS.ProcessEnv)
    ).toEqual('from-env')
  })

  it('falls back to REVIEW_VOTE_SALT when options is an empty object', () => {
    expect(resolveVoteSalt({}, { REVIEW_VOTE_SALT: 'from-env' } as NodeJS.ProcessEnv)).toEqual(
      'from-env'
    )
  })

  // The load-bearing case: an empty string is falsy, and it must not be
  // mistaken for a deliberately-configured salt that just happens to be
  // empty. If this ever regressed to `??` instead of `||`, this is the
  // test that would catch it - `??` treats '' as "set".
  it('treats an empty-string option as unset, not as a configured empty salt', () => {
    expect(
      resolveVoteSalt({ voteSalt: '' }, { REVIEW_VOTE_SALT: 'from-env' } as NodeJS.ProcessEnv)
    ).toEqual('from-env')
  })

  it('returns undefined - never a hardcoded default - when neither source is configured', () => {
    expect(resolveVoteSalt(undefined, {} as NodeJS.ProcessEnv)).toBeUndefined()
    expect(resolveVoteSalt({}, {} as NodeJS.ProcessEnv)).toBeUndefined()
  })
})
