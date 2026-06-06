# ingenium-bun

A `Bun.serve()` transport adapter for [Ingenium](../ingenium). Lets you
run an Ingenium app on the Bun runtime instead of `node:http`, with the
same handler surface and the same per-request `IngeniumContext`.

Requires the Bun runtime (`>=1.1.0`). `BunAdapter.listen()` throws if invoked
under Node — run your server with `bun`, not `node`. `ingenium` is a peer
dependency.

## Install

```sh
bun add ingenium ingenium-bun
```

## Use

```ts
import { ingenium } from 'ingenium'
import { BunAdapter } from 'ingenium-bun'

const app = ingenium({ transport: new BunAdapter() })

app.get('/', () => ({ hello: 'world' }))
app.get('/users/:id', (ctx) => ({ id: ctx.params.id }))

await app.listen(3000)
```

Run with:

```sh
bun run server.ts
```

## How it works

`BunAdapter` implements the framework's `Transport` interface. The app drives it
through `TransportHooks` (`acquire` / `dispatch` / `release`), the same contract
the built-in `NodeAdapter` uses, so the core dispatch path is identical to
running on `node:http`. On each request, the adapter:

1. **Pre-checks the request body size.** If `hooks.maxRequestBytes` is finite and
   the request declares a `Content-Length` over the cap, it returns `413` with
   `{ error, code: 'PAYLOAD_TOO_LARGE' }` *before* acquiring a context or
   bridging the body. Chunked / unknown-length bodies fall through to a
   byte-limit `Transform` that aborts mid-stream with the same error once the cap
   is exceeded.
2. Acquires a pooled `IngeniumContext` from the framework (`hooks.acquire()`).
3. Populates it from the WinterCG `Request` (method, url, path, rawQuery,
   headers, and a lazy body bridge — the body is only consumed if your
   handler calls `ctx.body.*`). Body wiring is skipped entirely for
   `GET`/`HEAD`/`OPTIONS` and `Content-Length: 0` requests.
4. Awaits dispatch (`hooks.dispatch(ctx)`).
5. Builds a `Response` from the context's status, headers, and body kind.
   Streamed bodies are converted from a `node:stream` `Readable` back to a
   WinterCG `ReadableStream` via `Readable.toWeb`; `204`/`304` responses send a
   `null` body so WinterCG runtimes don't throw.
6. Releases the context back to the pool (`hooks.release(ctx)`).

The adapter keeps zero coupling to Ingenium private modules — the byte-limit
helper is inlined rather than imported from a deep core path.

## Known limitations

- Handlers that rely on Node-only stream APIs (e.g. `.unshift`, raw socket
  access, `IncomingMessage` quirks) may behave differently under Bun.
- `req.body` is exposed as a Node `Readable` for compatibility with the rest
  of Ingenium, but the underlying source is a WinterCG stream — performance
  characteristics differ slightly from the `node:http` transport.
- Trailers and HTTP/2 push are not supported (Bun limitation).
