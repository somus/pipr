export function requiredHostEnv(env: NodeJS.ProcessEnv, name: string, host: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required for ${host} events`);
  return value;
}

export function positiveIntegerHostEnv(env: NodeJS.ProcessEnv, name: string, host: string): number {
  const value = Number(requiredHostEnv(env, name, host));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
