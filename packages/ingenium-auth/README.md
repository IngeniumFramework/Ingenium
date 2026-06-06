# ingenium-auth

JWT and API-key authentication middleware for [Ingenium](https://www.npmjs.com/package/ingenium).

Extracted from the core package so apps that don't authenticate pay nothing for the JWT/JWKS verification stack. `ingenium` is a peer dependency.

```sh
npm install ingenium ingenium-auth
```

## JWT

The verified token is attached at **`ctx.jwt`** (a `JwtVerified`, not on
`ctx.state`). The framework ships no baked-in `jwt` field — module-augment
`IngeniumContext` to type the payload for your app.

```ts
import { ingenium } from 'ingenium'
import { jwtMiddleware } from 'ingenium-auth'

declare module 'ingenium' {
  interface IngeniumContext {
    jwt?: import('ingenium-auth').JwtVerified<{ sub: string; roles: string[] }>
  }
}

const app = ingenium()

// HMAC secret (default algorithm: HS256)
app.use(jwtMiddleware({ secret: process.env.JWT_SECRET! }))

// or asymmetric / JWKS (issuer's public keys, fetched + cached).
// `secret: []` leans entirely on the JWKS endpoint; the default algorithm
// becomes RS256 when `jwksUrl` is set.
app.use(jwtMiddleware({
  secret: [],
  jwksUrl: 'https://issuer.example.com/.well-known/jwks.json',
  issuer: 'https://issuer.example.com/',
  audience: 'https://api.example.com',
}))

app.get('/me', (ctx) => ctx.json({ sub: ctx.jwt!.payload.sub }))
```

Hardening built in: `alg: none` and HS/RS key-confusion are rejected (an HMAC
algorithm paired with an asymmetric key throws `IngeniumJwtKeyAlgMismatchError`
at construction); `exp`/`nbf`/`iat` are enforced (with configurable clock skew,
default 5s; `requireExp` defaults to `true`); JWKS fetches block SSRF to internal
addresses, refuse redirects, cap the response body and key count, and coalesce
concurrent fetches behind a bounded cache (default TTL 10 minutes). The
wire-facing error is always `Invalid token` regardless of which check failed —
detailed reasons go to `opts.logger` (or `process.emitWarning`) to avoid handing
attackers an oracle. Set `required: false` to make a missing token pass through
without `ctx.jwt`.

## API key

The validated key is attached at **`ctx.apiKey`** (augment `IngeniumContext`
with `apiKey?: string` for typed access).

```ts
import { apiKeyMiddleware } from 'ingenium-auth'

// Static allow-list (compared in constant time via timingSafeEqual)
app.use(apiKeyMiddleware({ keys: [process.env.API_KEY!] }))

// or a custom validator (e.g. database lookup) — pass it as `keys`
app.use(apiKeyMiddleware({ keys: async (key, ctx) => lookupTenant(key) }))

// Read from a non-default surface: header, Authorization scheme, or query param
app.use(apiKeyMiddleware({
  keys: process.env.API_KEYS!.split(','),
  header: 'x-api-key',   // default
  scheme: 'ApiKey',      // also accept `Authorization: ApiKey <key>`
  query: 'api_key',      // also accept `?api_key=<key>`
}))
```

The candidate key is read in priority order: header → `Authorization` scheme →
query param. Like JWT, `required` defaults to `true`; set it `false` to let
missing keys pass through. The wire-facing error is always `Invalid API key`.

## Exports

| Export | Kind | Purpose |
| --- | --- | --- |
| `jwtMiddleware` | middleware | Verify a bearer JWT (secret, public key, or JWKS). Attaches `ctx.jwt`. |
| `verifyJwt` | function | Verify a token outside the request pipeline. |
| `fetchJwks` / `clearJwksCache` | function | JWKS fetch + cache control. |
| `apiKeyMiddleware` | middleware | Authenticate via an API key (allow-list or validator). Attaches `ctx.apiKey`. |
| `IngeniumJwtKeyAlgMismatchError` | error | Thrown at construction on key/algorithm misconfiguration. |

### Types

`JwtAlgorithm`, `JwtHeader`, `JwtKey`, `JwtOptions`, `JwtSecret`,
`JwtSecretResolver`, `JwtTokenReader`, `JwtVerified`, `JwtLogger` (JWT);
`ApiKeyOptions`, `ApiKeyValidator`, `ApiKeyLogger` (API key).

See the [Ingenium docs](https://www.npmjs.com/package/ingenium) for the full middleware contract.

## License

MIT
