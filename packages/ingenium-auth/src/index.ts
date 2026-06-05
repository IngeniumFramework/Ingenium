/**
 * ingenium-auth — JWT and API-key authentication middleware for Ingenium.
 *
 * Extracted from the core package so apps that don't authenticate pay nothing
 * for the JWT/JWKS verification stack. Install alongside `ingenium`:
 *
 * ```ts
 * import { ingenium } from 'ingenium'
 * import { jwtMiddleware, apiKeyMiddleware } from 'ingenium-auth'
 *
 * const app = ingenium()
 * app.use(jwtMiddleware({ secret: process.env.JWT_SECRET }))
 * ```
 *
 * @packageDocumentation
 */

// ───── JWT middleware ──────────────────────────────────────────────────────
export { jwtMiddleware, IngeniumJwtKeyAlgMismatchError } from './jwt/middleware.ts'
export { verifyJwt } from './jwt/verify.ts'
export { fetchJwks, clearJwksCache } from './jwt/jwks.ts'
export type {
  JwtAlgorithm,
  JwtHeader,
  JwtKey,
  JwtOptions,
  JwtSecret,
  JwtSecretResolver,
  JwtTokenReader,
  JwtVerified,
  JwtLogger,
} from './jwt/types.ts'

// ───── API-key middleware ──────────────────────────────────────────────────
export { apiKeyMiddleware } from './api-key/middleware.ts'
export type { ApiKeyOptions, ApiKeyValidator, ApiKeyLogger } from './api-key/types.ts'
