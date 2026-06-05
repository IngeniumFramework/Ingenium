# ingenium-auth

JWT and API-key authentication middleware for [Ingenium](https://www.npmjs.com/package/ingenium).

Extracted from the core package so apps that don't authenticate pay nothing for the JWT/JWKS verification stack. `ingenium` is a peer dependency.

```sh
npm install ingenium ingenium-auth
```

## JWT

```ts
import { ingenium } from 'ingenium'
import { jwtMiddleware } from 'ingenium-auth'

const app = ingenium()

// HMAC secret
app.use(jwtMiddleware({ secret: process.env.JWT_SECRET }))

// or asymmetric / JWKS (issuer's public keys, fetched + cached)
app.use(jwtMiddleware({ jwksUrl: 'https://issuer.example.com/.well-known/jwks.json' }))

app.get('/me', (ctx) => ctx.json({ sub: ctx.state.jwt.sub }))
```

Hardening built in: `alg: none` and HS/RS key-confusion are rejected; `exp`/`nbf`
are enforced (with configurable clock skew); JWKS fetches block SSRF to internal
addresses, refuse redirects, cap the response body and key count, and coalesce
concurrent fetches behind a bounded cache.

## API key

```ts
import { apiKeyMiddleware } from 'ingenium-auth'

// Static allow-list (compared in constant time)
app.use(apiKeyMiddleware({ keys: [process.env.API_KEY] }))

// or a custom validator (e.g. database lookup)
app.use(apiKeyMiddleware({ validate: async (key, ctx) => lookupTenant(key) }))
```

## Exports

| Export | Kind | Purpose |
| --- | --- | --- |
| `jwtMiddleware` | middleware | Verify a bearer JWT (secret, public key, or JWKS). |
| `verifyJwt` | function | Verify a token outside the request pipeline. |
| `fetchJwks` / `clearJwksCache` | function | JWKS fetch + cache control. |
| `apiKeyMiddleware` | middleware | Authenticate via an API key (allow-list or validator). |
| `IngeniumJwtKeyAlgMismatchError` | error | Thrown on key/algorithm misconfiguration. |

See the [Ingenium docs](https://www.npmjs.com/package/ingenium) for the full middleware contract.

## License

MIT
