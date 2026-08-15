import { formatStars, excerpt } from '../format'

describe('formatStars', () => {
  it('renders filled and empty stars', () => {
    expect(formatStars(3)).toEqual('★★★☆☆')
  })
  it('clamps out-of-range ratings instead of producing negative repeats', () => {
    expect(formatStars(0)).toEqual('☆☆☆☆☆')
    expect(formatStars(9)).toEqual('★★★★★')
  })
})

describe('excerpt', () => {
  it('leaves short text alone', () => {
    expect(excerpt('short', 20)).toEqual('short')
  })
  it('truncates on a word boundary and appends an ellipsis', () => {
    expect(excerpt('the quick brown fox jumps', 12)).toEqual('the quick…')
  })
})
