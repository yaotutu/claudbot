export type AsyncInputQueue<T> = {
  iterable: AsyncIterable<T>;
  push(value: T): void;
  close(): void;
  fail(error: Error): void;
};

export function createAsyncInputQueue<T>(): AsyncInputQueue<T> {
  const values: T[] = [];
  const waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  }> = [];
  let closed = false;
  let failure: Error | null = null;

  const next = (): Promise<IteratorResult<T>> => {
    if (values.length > 0) return Promise.resolve({ value: values.shift() as T, done: false });
    if (failure) return Promise.reject(failure);
    if (closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  };

  const flush = () => {
    while (waiters.length > 0 && values.length > 0) {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve({ value: values.shift() as T, done: false });
    }
    if (failure) {
      while (waiters.length > 0) waiters.shift()?.reject(failure);
      return;
    }
    if (closed) {
      while (waiters.length > 0) waiters.shift()?.resolve({ value: undefined, done: true });
    }
  };

  return {
    iterable: {
      [Symbol.asyncIterator]() {
        return { next };
      },
    },
    push(value) {
      if (closed || failure) throw new Error("input queue is closed");
      values.push(value);
      flush();
    },
    close() {
      closed = true;
      flush();
    },
    fail(error) {
      failure = error;
      flush();
    },
  };
}
