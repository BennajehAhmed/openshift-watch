import path from 'node:path';

export function integer(value, fallback, min, max) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Expected an integer from ${min} to ${max}.`);
  return n;
}
export function namespaces(value) {
  if (!Array.isArray(value) || value.length > 50) throw new Error('Choose up to 50 namespaces.');
  const unique = [...new Set(value)];
  for (const name of unique) {
    if (typeof name !== 'string' || name.length > 63 || !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(name)) {
      throw new Error('Invalid namespace name. Use the OpenShift project name.');
    }
  }
  return unique;
}
export function getConfig(env = process.env) {
  return {
    port: integer(env.PORT, 3100, 1024, 65535),
    ocBin: env.OC_BIN || 'oc', context: env.OC_CONTEXT || '',
    namespaces: namespaces((env.NAMESPACES || '').split(',').map(s => s.trim()).filter(Boolean)),
    pollSeconds: integer(env.POLL_SECONDS, 30, 5, 3600),
    timeoutSeconds: integer(env.COMMAND_TIMEOUT_SECONDS, 15, 2, 120),
    alertAfter: integer(env.ALERT_AFTER_CHECKS, 2, 1, 20),
    alertDegraded: env.ALERT_ON_DEGRADED !== 'false',
    dataDir: path.resolve('data'), demo: process.argv.includes('--demo')
  };
}
