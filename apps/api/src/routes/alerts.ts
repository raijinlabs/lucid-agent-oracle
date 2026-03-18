import type { FastifyInstance } from 'fastify'
import { Type } from '@sinclair/typebox'
import { nanoid } from 'nanoid'
import { requireTier } from '../plugins/auth.js'
import {
  CreateAlertBody,
  CreateAlertResponse,
  AlertListResponse,
  AlertIdParams,
} from '../schemas/alerts.js'
import {
  generateWebhookSecret,
  encryptSecret,
  validateWebhookUrl,
} from '../utils/crypto.js'

type DbClient = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }

const LIMITS: Record<string, number> = { pro: 10, growth: 100 }

// ── Core logic (exported for testing) ────────────────────────

export async function createAlert(
  db: DbClient,
  opts: { tenantId: string; plan: string; body: CreateAlertBody },
): Promise<{
  subscription?: Record<string, unknown>
  secret?: string
  error?: string
  status?: number
}> {
  const { tenantId, plan, body } = opts

  // Validate URL
  const urlCheck = validateWebhookUrl(body.url)
  if (!urlCheck.valid) {
    return { error: urlCheck.error!, status: 400 }
  }

  // Check subscription limit
  const limit = LIMITS[plan] ?? 10
  const countResult = await db.query(
    'SELECT COUNT(*)::int AS count FROM oracle_subscriptions WHERE tenant_id = $1 AND active = true',
    [tenantId],
  )
  const currentCount = parseInt((countResult.rows[0] as Record<string, string>).count, 10)
  if (currentCount >= limit) {
    return { error: `Subscription limit reached (${limit} for ${plan} plan)`, status: 429 }
  }

  // Generate and encrypt secret
  const secret = generateWebhookSecret()
  const secretEncrypted = encryptSecret(secret)

  // Insert
  const id = `sub_${nanoid(16)}`
  await db.query(
    `INSERT INTO oracle_subscriptions
      (id, tenant_id, type, channel, webhook_url, filter_json, conditions_json, secret_encrypted, active)
     VALUES ($1, $2, 'webhook', $3, $4, $5, $6, $7, true)`,
    [
      id,
      tenantId,
      body.channel,
      body.url,
      body.filter ? JSON.stringify(body.filter) : null,
      body.conditions ? JSON.stringify(body.conditions) : null,
      secretEncrypted,
    ],
  )

  return {
    subscription: {
      id,
      channel: body.channel,
      url: body.url,
      filter: body.filter,
      conditions: body.conditions,
      active: true,
      created_at: new Date().toISOString(),
    },
    secret,
  }
}

export async function listAlerts(
  db: DbClient,
  tenantId: string,
): Promise<{ data: Record<string, unknown>[] }> {
  const result = await db.query(
    `SELECT id, channel, webhook_url, filter_json, conditions_json, active, created_at
     FROM oracle_subscriptions
     WHERE tenant_id = $1 AND active = true AND type = 'webhook'
     ORDER BY created_at DESC`,
    [tenantId],
  )
  return {
    data: result.rows.map((row: any) => ({
      id: row.id,
      channel: row.channel,
      url: row.webhook_url,
      filter: row.filter_json,
      conditions: row.conditions_json,
      active: row.active,
      created_at: row.created_at,
    })),
  }
}

export async function deleteAlert(
  db: DbClient,
  alertId: string,
  tenantId: string,
): Promise<{ error?: string; status?: number }> {
  const result = await db.query(
    `UPDATE oracle_subscriptions SET active = false
     WHERE id = $1 AND tenant_id = $2 AND active = true
     RETURNING id`,
    [alertId, tenantId],
  )
  if (result.rows.length === 0) {
    return { error: 'Alert subscription not found', status: 404 }
  }
  return {}
}

// ── Route registration ───────────────────────────────────────

export function registerAlertRoutes(
  app: FastifyInstance,
  db: DbClient,
): void {
  app.post('/v1/oracle/alerts', {
    schema: {
      tags: ['alerts'],
      summary: 'Create webhook alert subscription',
      body: CreateAlertBody,
      response: {
        201: CreateAlertResponse,
        400: { $ref: 'ProblemDetail' },
        403: { $ref: 'ProblemDetail' },
        429: { $ref: 'ProblemDetail' },
      },
    },
    preHandler: [requireTier('pro')],
    config: { rateLimit: { max: 10 } },
  }, async (request, reply) => {
    const tenantId = request.tenant.id
    if (!tenantId) {
      return reply.code(401).header('content-type', 'application/problem+json').send({
        type: 'https://oracle.lucid.foundation/errors/unauthorized',
        title: 'Unauthorized',
        status: 401,
      })
    }
    const result = await createAlert(db, {
      tenantId,
      plan: request.tenant.plan,
      body: request.body as CreateAlertBody,
    })
    if (result.error) {
      return reply.code(result.status!).header('content-type', 'application/problem+json').send({
        type: 'https://oracle.lucid.foundation/errors/alert-error',
        title: result.error,
        status: result.status,
        detail: result.error,
      })
    }
    return reply.code(201).send({
      subscription: result.subscription,
      secret: result.secret,
    })
  })

  app.get('/v1/oracle/alerts', {
    schema: {
      tags: ['alerts'],
      summary: 'List webhook alert subscriptions',
      response: {
        200: AlertListResponse,
        403: { $ref: 'ProblemDetail' },
      },
    },
    preHandler: [requireTier('pro')],
  }, async (request, _reply) => {
    const tenantId = request.tenant.id ?? ''
    return listAlerts(db, tenantId)
  })

  app.delete('/v1/oracle/alerts/:id', {
    schema: {
      tags: ['alerts'],
      summary: 'Delete webhook alert subscription',
      params: AlertIdParams,
      response: {
        204: Type.Null(),
        403: { $ref: 'ProblemDetail' },
        404: { $ref: 'ProblemDetail' },
      },
    },
    preHandler: [requireTier('pro')],
  }, async (request, reply) => {
    const { id } = request.params as AlertIdParams
    const tenantId = request.tenant.id ?? ''
    const result = await deleteAlert(db, id, tenantId)
    if (result.error) {
      return reply.code(result.status!).header('content-type', 'application/problem+json').send({
        type: 'https://oracle.lucid.foundation/errors/alert-not-found',
        title: result.error,
        status: result.status,
      })
    }
    return reply.code(204).send()
  })
}
