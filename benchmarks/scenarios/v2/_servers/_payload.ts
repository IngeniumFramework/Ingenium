/**
 * Deterministic in-process payload builders for the payload-size scenarios.
 *
 * WHY build at runtime instead of committing a fixture: a 100KB JSON file in
 * git is noise in every diff and tempts someone to "tune" it. Generating from
 * a fixed seed string guarantees every framework echoes byte-identical bytes,
 * so the only variable across the matrix is the framework, not the data.
 *
 * The builder repeats a known record until the serialized JSON crosses the
 * target byte size, then reports the exact size it produced. It is pure and
 * deterministic: same target in, same object out, on every process and runtime.
 */

export interface BuiltPayload {
  /** The object servers echo back. */
  object: { items: PayloadItem[] }
  /** `JSON.stringify(object)` — handy for request bodies and size asserts. */
  json: string
  /** Actual serialized byte length (UTF-8). Always >= the requested target. */
  bytes: number
}

interface PayloadItem {
  id: number
  name: string
  tag: string
  active: boolean
  value: number
}

// A fixed, ASCII-only seed so byte length == char length and the output is
// identical on every platform regardless of locale.
const SEED_TAG = 'ingenium-bench-payload-fixture'

function makeItem(i: number): PayloadItem {
  return {
    id: i,
    name: `item-${i}`,
    tag: SEED_TAG,
    active: (i & 1) === 0,
    value: i * 7,
  }
}

/**
 * Build a payload whose `JSON.stringify` is at least `targetBytes` long.
 * Deterministic: the i-th item is a pure function of i.
 */
export function buildPayload(targetBytes: number): BuiltPayload {
  const items: PayloadItem[] = []
  let json = ''
  let i = 0
  // Append items until the serialized form crosses the target. Cheap to do
  // up front once at boot — never on the hot request path.
  do {
    items.push(makeItem(i))
    i++
    json = JSON.stringify({ items })
  } while (Buffer.byteLength(json, 'utf8') < targetBytes)

  return { object: { items }, json, bytes: Buffer.byteLength(json, 'utf8') }
}

/** ~1 KB payload. */
export const PAYLOAD_1KB = 1_024
/** ~100 KB payload. */
export const PAYLOAD_100KB = 100 * 1_024
