#!/usr/bin/env node
// Node.js 18+: send synthetic OTLP logs, metrics, and a cross-service trace.
const { randomBytes } = require('node:crypto');
const { parseArgs } = require('node:util');

function attributes(values) {
  return Object.entries(values).map(([key, value]) => ({
    key, value: { stringValue: value },
  }));
}

function resource(service, instance) {
  return {
    attributes: attributes({
      'service.name': service,
      'service.namespace': 'observability-smoke',
      'service.instance.id': instance,
      'deployment.environment.name': 'local',
    }),
  };
}

async function send(endpoint, signal, payload) {
  let response;
  try {
    response = await fetch(`${endpoint.replace(/\/+$/, '')}/v1/${signal}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`${signal}: cannot reach collector: ${error.cause?.message ?? error.message}`);
  }
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${signal}: HTTP ${response.status}: ${body}`);
  }
  const result = body ? JSON.parse(body) : {};
  const partial = result.partialSuccess ?? result.partial_success ?? {};
  const rejected = Object.entries(partial).some(
    ([key, value]) => key.startsWith('rejected') && Number(value) > 0,
  );
  if (rejected || partial.errorMessage || partial.error_message) {
    throw new Error(`${signal}: collector reported partial success: ${JSON.stringify(partial)}`);
  }
  console.log(`Collector accepted ${signal}`);
}

function span(traceId, spanId, name, kind, start, end, parentSpanId) {
  return {
    traceId, spanId, name, kind,
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: end.toString(),
    status: { code: 1 },
    ...(parentSpanId ? { parentSpanId } : {}),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      endpoint: { type: 'string', default: 'http://localhost:4318' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log('Usage: node observability/smoke.js [--endpoint http://localhost:4318]');
    return;
  }
  const url = new URL(values.endpoint);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Endpoint must use http:// or https://');
  }

  // BigInt preserves nanosecond timestamps when serialized as OTLP strings.
  const now = BigInt(Date.now()) * 1_000_000n;
  const start = now - 100_000_000n;
  const firstSample = now - 10_000_000n;
  const traceId = randomBytes(16).toString('hex');
  const [serverId, clientId, downstreamId] = Array.from(
    { length: 3 }, () => randomBytes(8).toString('hex'),
  );
  const instance = `smoke-${randomBytes(4).toString('hex')}`;
  const services = ['project-a-api', 'project-b-worker'];
  const scope = { name: 'dev-tools.observability-smoke' };
  const resources = services.map(service => resource(service, instance));

  const traces = {
    resourceSpans: [
      {
        resource: resources[0],
        scopeSpans: [{ scope, spans: [
          span(traceId, serverId, 'smoke.request', 2, start, now),
          span(traceId, clientId, 'smoke.downstream', 3,
            start + 10_000_000n, now - 10_000_000n, serverId),
        ] }],
      },
      {
        resource: resources[1],
        scopeSpans: [{ scope, spans: [
          span(traceId, downstreamId, 'smoke.process', 2,
            start + 20_000_000n, now - 20_000_000n, clientId),
        ] }],
      },
    ],
  };
  const logs = {
    resourceLogs: resources.map((value, index) => ({
      resource: value,
      scopeLogs: [{ scope, logRecords: [{
        timeUnixNano: now.toString(),
        observedTimeUnixNano: now.toString(),
        severityNumber: 9,
        severityText: 'INFO',
        body: { stringValue: `Observability smoke test: ${services[index]}` },
        traceId,
        spanId: [serverId, downstreamId][index],
      }] }],
    })),
  };

  function metrics(sampleTime, intervalStart, delta, includeGauge) {
    return {
      resourceMetrics: resources.map(value => {
        const signals = [{
          name: 'observability_smoke_requests',
          description: 'Synthetic requests to exercise delta conversion',
          sum: {
            aggregationTemporality: 1,
            isMonotonic: true,
            dataPoints: [{
              startTimeUnixNano: intervalStart.toString(),
              timeUnixNano: sampleTime.toString(),
              asInt: delta.toString(),
            }],
          },
        }];
        if (includeGauge) {
          signals.push({
            name: 'observability_smoke_value',
            gauge: { dataPoints: [{
              timeUnixNano: sampleTime.toString(), asDouble: 1,
            }] },
          });
        }
        return { resource: value, scopeMetrics: [{ scope, metrics: signals }] };
      }),
    };
  }

  await send(values.endpoint, 'traces', traces);
  await send(values.endpoint, 'logs', logs);
  await send(values.endpoint, 'metrics', metrics(firstSample, start, 1, false));
  await send(values.endpoint, 'metrics', metrics(now, firstSample, 2, true));
  console.log(`Services: ${services.join(', ')}`);
  console.log(`Instance: ${instance}`);
  console.log(`Trace ID: ${traceId}`);
  console.log(`Sample timestamp (seconds): ${now / 1_000_000_000n}.${
    (now % 1_000_000_000n).toString().padStart(9, '0')}`);
  console.log('Wait a few seconds, then verify all three signals in Grafana Explore.');
  console.log('An accepted request does not guarantee delivery to a backend.');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
