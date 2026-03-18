/**
 * OpenTelemetry instrumentation — lazy-loaded, fail-safe.
 *
 * Only imports OTel SDK when OTEL_ENABLED !== 'false'.
 * Crashes in OTel never bring down the API.
 */

export function startTelemetry(): void {
  if (process.env.OTEL_ENABLED === 'false') return

  // Dynamic import so OTel modules are only loaded when needed
  Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/auto-instrumentations-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/exporter-metrics-otlp-http'),
    import('@opentelemetry/sdk-metrics'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/semantic-conventions'),
  ]).then(([
    { NodeSDK },
    { getNodeAutoInstrumentations },
    { OTLPTraceExporter },
    { OTLPMetricExporter },
    { PeriodicExportingMetricReader },
    resourceMod,
    semconv,
  ]) => {
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318'
    const serviceName = process.env.OTEL_SERVICE_NAME ?? 'oracle-api'

    // Handle different @opentelemetry/resources export shapes
    const Resource = (resourceMod as any).Resource ?? (resourceMod as any).default?.Resource
    const ATTR_SERVICE_NAME = (semconv as any).ATTR_SERVICE_NAME ?? 'service.name'
    const ATTR_SERVICE_VERSION = (semconv as any).ATTR_SERVICE_VERSION ?? 'service.version'

    const resource = Resource
      ? new Resource({
          [ATTR_SERVICE_NAME]: serviceName,
          [ATTR_SERVICE_VERSION]: '0.1.0',
          'deployment.environment': process.env.NODE_ENV ?? 'development',
        })
      : undefined

    const sdk = new NodeSDK({
      resource,
      traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      metricReader: new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
        exportIntervalMillis: 15_000,
      }),
      instrumentations: [
        getNodeAutoInstrumentations({
          '@opentelemetry/instrumentation-fs': { enabled: false },
          '@opentelemetry/instrumentation-http': {
            ignoreIncomingPaths: ['/health', '/metrics'],
          },
        }),
      ],
    })

    sdk.start()
    console.log(`[otel] Telemetry started → ${endpoint} (service: ${serviceName})`)

    // Store for shutdown
    ;(globalThis as any).__otelSdk = sdk
  }).catch((err) => {
    console.warn('[otel] Failed to start telemetry (non-fatal):', (err as Error).message)
  })
}

export async function shutdownTelemetry(): Promise<void> {
  const sdk = (globalThis as any).__otelSdk
  if (sdk) await sdk.shutdown().catch(() => {})
}
