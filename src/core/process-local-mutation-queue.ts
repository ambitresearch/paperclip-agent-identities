const queuesByOwner = new WeakMap<object, Map<string, Promise<void>>>();

async function withProcessLocalLock<T>(
  owner: object,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  let queues = queuesByOwner.get(owner);
  if (!queues) {
    queues = new Map();
    queuesByOwner.set(owner, queues);
  }

  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => hold);
  queues.set(key, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(key) === tail) {
      queues.delete(key);
      if (queues.size === 0) queuesByOwner.delete(owner);
    }
  }
}

export async function withProcessLocalLocks<T>(
  owner: object,
  keys: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const orderedKeys = [...new Set(keys)].sort();

  async function acquire(index: number): Promise<T> {
    const key = orderedKeys[index];
    if (!key) return await operation();
    return await withProcessLocalLock(owner, key, async () => await acquire(index + 1));
  }

  return await acquire(0);
}

export function processLocalIdentityMutationKeys(
  namespace: string,
  companyId: string,
  agentId: string,
): readonly string[] {
  return [
    `${namespace}:document`,
    `${namespace}:company-agent:${JSON.stringify([companyId, agentId])}`,
  ];
}
