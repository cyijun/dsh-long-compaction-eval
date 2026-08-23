/** Character SequenceMatcher compatible with Python difflib's no-junk ratio. */

interface Match {
  a: number
  b: number
  size: number
}

/** Return Python-compatible `difflib.SequenceMatcher(a, b).ratio()`. */
export function sequenceMatcherRatio(a: string, b: string): number {
  if (a.length + b.length === 0) return 1
  const matcher = new SequenceMatcher([...a], [...b])
  const matches = matcher.matchingBlocks().reduce((total, block) => total + block.size, 0)
  return (2 * matches) / (a.length + b.length)
}

class SequenceMatcher {
  private readonly b2j = new Map<string, number[]>()

  constructor(
    private readonly a: readonly string[],
    private readonly b: readonly string[],
  ) {
    for (const [index, item] of b.entries()) {
      const positions = this.b2j.get(item)
      if (positions === undefined) this.b2j.set(item, [index])
      else positions.push(index)
    }
    if (b.length >= 200) {
      const popularThreshold = Math.floor(b.length / 100) + 1
      for (const [item, positions] of this.b2j) {
        if (positions.length > popularThreshold) this.b2j.delete(item)
      }
    }
  }

  matchingBlocks(): Match[] {
    const queue: Array<[number, number, number, number]> = [[0, this.a.length, 0, this.b.length]]
    const matches: Match[] = []
    while (queue.length > 0) {
      const [alo, ahi, blo, bhi] = queue.pop() ?? [0, 0, 0, 0]
      const match = this.findLongestMatch(alo, ahi, blo, bhi)
      if (match.size === 0) continue
      matches.push(match)
      if (alo < match.a && blo < match.b) queue.push([alo, match.a, blo, match.b])
      if (match.a + match.size < ahi && match.b + match.size < bhi) {
        queue.push([match.a + match.size, ahi, match.b + match.size, bhi])
      }
    }
    matches.sort((left, right) => left.a - right.a || left.b - right.b)
    const collapsed: Match[] = []
    for (const match of matches) {
      const previous = collapsed.at(-1)
      if (previous !== undefined
        && previous.a + previous.size === match.a
        && previous.b + previous.size === match.b) {
        previous.size += match.size
      } else {
        collapsed.push({ ...match })
      }
    }
    collapsed.push({ a: this.a.length, b: this.b.length, size: 0 })
    return collapsed
  }

  private findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): Match {
    let besti = alo
    let bestj = blo
    let bestsize = 0
    let previousLengths = new Map<number, number>()
    for (let i = alo; i < ahi; i += 1) {
      const currentLengths = new Map<number, number>()
      for (const j of this.b2j.get(this.a[i] ?? '') ?? []) {
        if (j < blo) continue
        if (j >= bhi) break
        const size = (previousLengths.get(j - 1) ?? 0) + 1
        currentLengths.set(j, size)
        if (size > bestsize) {
          besti = i - size + 1
          bestj = j - size + 1
          bestsize = size
        }
      }
      previousLengths = currentLengths
    }
    while (besti > alo && bestj > blo && this.a[besti - 1] === this.b[bestj - 1]) {
      besti -= 1
      bestj -= 1
      bestsize += 1
    }
    while (besti + bestsize < ahi
      && bestj + bestsize < bhi
      && this.a[besti + bestsize] === this.b[bestj + bestsize]) {
      bestsize += 1
    }
    return { a: besti, b: bestj, size: bestsize }
  }
}
