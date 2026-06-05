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
import { Ingenium } from 'ingenium'
import { expressCompat } from 'ingenium-compat'
import helmet from 'helmet'
import cors from 'cors'

const app = new Ingenium()

app.use(expressCompat(helmet()))
app.use(expressCompat(cors()))

app.get('/', () => ({ ok: true }))

app.listen(3000)
```

## Supported middleware

`cors`, `helmet`, `cookie-parser`, `morgan`, `express-rate-limit`,
`compression`, `body-parser`, `express-session`, `multer`, and
`passport.initialize` are verified end-to-end. `passport.authenticate` is
partially supported (session-backed strategies need a session store).

See [`COMPATIBILITY.md`](./COMPATIBILITY.md) for the full matrix, per-middleware
notes, and how the shim works.

## License

MIT
