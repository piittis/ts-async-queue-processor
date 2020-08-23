import { Transform } from 'stream';

interface processor {
  activeWorkers: number,
  queue: WorkItem[];
}

interface WorkItem {
  task: (param?: any) => Promise<any>;
  resolve: (result: any) => any;
  reject: (err: any) => any
}

/**
 * Processes async tasks in a FIFO manner using a configurable amount of concurrency and pending tasks.
 * can be used for critical sections when maxConcurrency = 1.
 *
 * usage:
 * const processor = new AsyncProcessor({
 *  maxConcurrency: 1,
 *  maxPending: 10
 * });
 *
 * const newFoo = await processor.process('foo', async () => {
 *  const foo = await getFoo();
 *  const bar = await getBar();
 *  foo.bar = bar;
 *  await save(foo);
 *  return foo;
 * });
 */
export class AsyncQueueProcessor {
  private maxConcurrency: number;
  private maxPending: number;
  private limitPending: boolean;
  private processors: Record<string, processor | undefined> = {};

  public constructor(opts?: { maxConcurrency?: number; maxPending?: number }) {
    this.maxConcurrency = opts?.maxConcurrency ?? 1;
    this.maxPending = opts?.maxPending ?? 0;
    this.limitPending = this.maxPending !== 0;
  }

  public processMany<T>(key: string, tasks: Array<() => Promise<T>>): Promise<T[]> {
    return Promise.all(tasks.map((task) => this.process(key, task)));
  }

  public process<T>(key: string, task: () => Promise<T>): Promise<T> {
    if (this.limitPending && (this.processors[key]?.queue?.length ?? 0) >= this.maxPending) {
      return Promise.reject('pending');
    }
    return new Promise<T>((resolve, reject) => {
      this.enqueueWork(key, {task, resolve, reject});
    });
  }

  // TODO
  public streamTransform<T, E>(key: string, task: (input: T) => Promise<E>): Transform {

    function streamTask(chunk: T) {
      return task(chunk);
    }

    const self = this;
    return new Transform({
      transform(chunk: T, enc, callback) {
        // TODO can we hoist this? Maybe share a single WorkItem for all transform invocations.
        const work: WorkItem = {
          task: streamTask,
          resolve: (output: E) => callback(null, output),
          reject: () => callback(new Error('pass error here'))
        }
        self.enqueueWork(key, work);
      }
    });
  }

  private enqueueWork(key: string, work: WorkItem) {
    if (!this.processors[key]) {
      this.processors[key] = {
        activeWorkers: 0,
        queue: [work]
      };
    } else {
      this.processors[key]!.queue.push(work);
    }
    if (this.processors[key]!.activeWorkers < this.maxConcurrency) {
      void this.startProcessor(key);
    }
  }

  private async startProcessor(key: string) {
    const processor = this.processors[key];
    if (!processor) return;
    processor.activeWorkers += 1;

    let nextWork: WorkItem | undefined;
    while (nextWork = processor.queue.shift()) {
      const {task, resolve, reject} = nextWork;
      try {
        resolve(await task());
      } catch (err) {
        reject(err);
      }
    }

    processor.activeWorkers -= 1;
    if (processor.activeWorkers < 1) {
      delete this.processors[key];
    }
  }
}