# ingenium-compat

Express middleware compatibility shim for [Ingenium](../ingenium). Wrap an
Express-style `(req, res, next)` middleware with `expressCompat()` and run it
inside an Ingenium middleware chain.

The shims are **real Node streams** — `req` extends `stream.Readable`, `res`
extends `stream.Writable` — wired directly to the `IngeniumContext`. That makes
most Express middleware a genuine drop-in: body-reading and response-transforming
middleware work end-to-end.

## Install

```sh
npm add ingenium ingenium-compat
```

## Use

```ts
import { ingenium } from 'ingenium'
import { expressCompat } from 'ingenium-compat'
import helmet from 'helmet'
import cors from 'cors'

const app = ingenium()

app.use(expressCompat(helmet()))
app.use(expressCompat(cors()))

app.get('/', () => ({ ok: true }))

await app.listen(3000)
```

`expressCompat(mw)` returns an `IngeniumMiddleware`. The cost is opt-in and
localized — only requests that pass through a wrapped middleware pay for it;
native handlers and native middleware run at full speed.

## Supported middleware

`cors`, `helmet`, `cookie-parser`, `morgan`, `express-rate-limit`,
`compression`, `body-parser`, `express-session`, `multer`, and
`passport.initialize` are verified end-to-end. `passport.authenticate` is
partially supported (session-backed strategies need a session store).

See [`COMPATIBILITY.md`](./COMPATIBILITY.md) for the full matrix, per-middleware
notes, and how the shim works.

## Exports

| Export | Kind | Purpose |
| --- | --- | --- |
| `expressCompat(mw, opts?)` | function | Wrap an Express `(req, res, next)` middleware as an `IngeniumMiddleware`. |
| `ExpressMiddleware` | type | The Express-style middleware signature it accepts. |
| `ExpressCompatOptions` | type | Options bag (see below). |
| `createReqShim` / `IngeniumReqShim` | function / class | The `Readable` request shim wired to the context (advanced/testing use). |
| `createResShim` / `IngeniumResShim` | function / class | The `Writable` response shim wired to the context. |
| `syncReqStateBack` | function | Mirror `req.*` mutations back into `ctx.state`. |

`ExpressCompatOptions` currently only carries `allowKnownBroken?: boolean`, which
is **deprecated and ignored** — the shims are now real Node streams, so the
middleware that used to be "known broken" (body-parser, multer, compression,
express-session, …) work through `expressCompat`. The flag is kept only so older
call sites keep compiling.

## License

MIT
