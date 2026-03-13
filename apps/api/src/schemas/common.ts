import { Type, type Static, type TSchema } from '@sinclair/typebox'
import type { FastifyInstance, FastifyReply } from 'fastify'

// ---------------------------------------------------------------------------
// RFC 9457 Problem Detail
// ---------------------------------------------------------------------------

export const ProblemDetail = Type.Object(
  {
    type: Type.String(),
    title: Type.String(),
    status: Type.Integer(),
    detail: Type.Optional(Type.String()),
    instance: Type.Optional(Type.String()),
    code: Type.Optional(Type.String()),
  },
  { $id: 'ProblemDetail' },
)

export type ProblemDetail = Static<typeof ProblemDetail>

const ERROR_BASE_URI = 'https://oracle.lucid.foundation/errors/'

export interface SendProblemOpts {
  type: string
  title: string
  detail?: string
  instance?: string
  code?: string
}

export function sendProblem(
  reply: FastifyReply,
  status: number,
  opts: SendProblemOpts,
): ReturnType<FastifyReply['send']> {
  const body: ProblemDetail = {
    type: `${ERROR_BASE_URI}${opts.type}`,
    title: opts.title,
    status,
    ...(opts.detail !== undefined && { detail: opts.detail }),
    ...(opts.instance !== undefined && { instance: opts.instance }),
    ...(opts.code !== undefined && { code: opts.code }),
  }
  return reply
    .status(status)
    .header('content-type', 'application/problem+json')
    .send(body)
}

// ---------------------------------------------------------------------------
// Cursor pagination
// ---------------------------------------------------------------------------

export const CursorQuery = Type.Object(
  {
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 100, default: 20 }),
    ),
    cursor: Type.Optional(Type.String()),
  },
  { $id: 'CursorQuery' },
)

export type CursorQuery = Static<typeof CursorQuery>

export const CursorMeta = Type.Object(
  {
    next_cursor: Type.Union([Type.String(), Type.Null()]),
    has_more: Type.Boolean(),
    limit: Type.Integer(),
  },
  { $id: 'CursorMeta' },
)

export type CursorMeta = Static<typeof CursorMeta>

export function PaginatedList<T extends TSchema>(
  itemSchema: T,
  $id: string,
) {
  return Type.Object(
    {
      data: Type.Array(itemSchema),
      pagination: CursorMeta,
    },
    { $id },
  )
}

// ---------------------------------------------------------------------------
// ID params
// ---------------------------------------------------------------------------

export const AgentIdParams = Type.Object(
  {
    id: Type.String({
      minLength: 4,
      maxLength: 30,
      pattern: '^ae_[a-zA-Z0-9_-]+$',
    }),
  },
  { $id: 'AgentIdParams' },
)

export type AgentIdParams = Static<typeof AgentIdParams>

export const ProtocolIdParams = Type.Object(
  {
    id: Type.String({
      minLength: 2,
      maxLength: 50,
      pattern: '^[a-z0-9_-]+$',
    }),
  },
  { $id: 'ProtocolIdParams' },
)

export type ProtocolIdParams = Static<typeof ProtocolIdParams>

// ---------------------------------------------------------------------------
// Data envelope
// ---------------------------------------------------------------------------

export function DataEnvelope<T extends TSchema>(dataSchema: T, $id: string) {
  return Type.Object(
    {
      data: dataSchema,
    },
    { $id },
  )
}

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------

interface AjvValidationError extends Error {
  validation?: unknown[]
  validationContext?: string
  statusCode?: number
}

interface RateLimitError extends Error {
  statusCode?: number
}

export function registerGlobalErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: Error & { statusCode?: number; validation?: unknown[] }, _request, reply) => {
    // Ajv validation errors — Fastify attaches .validation array
    const maybeValidation = error as AjvValidationError
    if (
      Array.isArray(maybeValidation.validation) &&
      maybeValidation.validation.length > 0
    ) {
      return sendProblem(reply, 400, {
        type: 'validation-error',
        title: 'Validation Error',
        detail: error.message,
        code: 'VALIDATION_ERROR',
      })
    }

    const status = (error as RateLimitError).statusCode ?? 500

    // Rate limit errors
    if (status === 429) {
      return sendProblem(reply, 429, {
        type: 'rate-limited',
        title: 'Too Many Requests',
        detail: error.message || 'You have exceeded the rate limit.',
        code: 'RATE_LIMITED',
      })
    }

    // Bad-request range (4xx except 429)
    if (status >= 400 && status < 500) {
      return sendProblem(reply, status, {
        type: 'bad-request',
        title: 'Bad Request',
        detail: error.message,
        code: 'BAD_REQUEST',
      })
    }

    // Everything else → internal error
    return sendProblem(reply, status >= 100 && status < 600 ? status : 500, {
      type: 'internal-error',
      title: 'Internal Server Error',
      detail:
        process.env.NODE_ENV !== 'production'
          ? error.message
          : 'An unexpected error occurred.',
      code: 'INTERNAL_ERROR',
    })
  })
}
