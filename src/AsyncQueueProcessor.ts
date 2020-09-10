import { Transform } from 'stream';
import { performance } from 'perf_hooks';

interface processor {
  activeWorkers: number;
  limiter: limiter | null;
  queue: WorkItem[];
}

interface WorkItem {
  priority: number;
  task: (param?: any) => Promise<any>;
  resolve: (result: any) => any;
  reject: (err: any) => any;
}

interface QueueProcessor {
  process<T>(task: () => Promise<T>): Promise<T>;
  data<T>(iter: Iterable<T>): Pipeline<T>;
}

interface ProcessorOpts {
  concurrency?: number;
  maxPending?: number;
  rateLimit?: LimiterOpts
}

interface LimiterOpts {
  limit: [number, 'second' | 'minute'],
  tickRate?: number;
  burst?: boolean;
  burstSlots?: number;
}

interface ProcessOpts {
  key?: string | number;
  proprity?: number;
}

export class AsyncQueueProcessor implements QueueProcessor {
  private maxConcurrency: number;
  private maxPending: number;
  private limitPending: boolean;
  private processors: Record<string | number, processor | undefined> = {};

  public constructor(private opts?: ProcessorOpts) {
    this.maxConcurrency = opts?.concurrency ?? 1;
    this.maxPending = opts?.maxPending ?? Number.MAX_SAFE_INTEGER;
    this.limitPending = this.maxPending !== 0;
  }

  public pipe(child: QueueProcessor) {
    return new PipedProcessor(this, child);
  }

  public with(opts: ProcessOpts) {
    return new ProcessorWithOpts(opts, this);
  }

  public processMany<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
    return this.processManyWith(tasks);
  }

  public processManyWith<T>(tasks: Array<() => Promise<T>>, opts?: ProcessOpts): Promise<T[]> {
    return Promise.all(tasks.map((task) => this.processWith(task, opts)));
  }

  public process<T>(task: () => Promise<T>): Promise<T> {
    return this.processWith(task);
  }

  public processWith<T>(task: () => Promise<T>, opts?: ProcessOpts): Promise<T> {
    const key = opts?.key ?? '__default__';
    const priority = opts?.proprity ?? Number.MIN_SAFE_INTEGER;

    if (this.limitPending && (this.processors[key]?.queue?.length ?? 0) >= this.maxPending) {
      return Promise.reject('pending');
    }

    return new Promise<T>((resolve, reject) => {
      this.enqueueWork(key, {task, resolve, reject, priority});
    });
  }

  // TODO
  // public streamTransform<T, E>(key: string, task: (input: T) => Promise<E>): Transform {

  //   function streamTask(chunk: T) {
  //     return task(chunk);
  //   }

  //   const self = this;
  //   return new Transform({
  //     transform(chunk: T, enc, callback) {
  //       // TODO can we hoist this? Maybe share a single WorkItem for all transform invocations.
  //       const work: WorkItem = {
  //         task: streamTask,
  //         resolve: (output: E) => callback(null, output),
  //         reject: () => callback(new Error('pass error here'))
  //       }
  //       self.enqueueWork(key, work);
  //     }
  //   });
  // }

  public generate<T>(iter: AsyncGenerator<T>): Pipeline<T> {
    return new Pipeline(this, iter);
  }

  public data<T>(iter: Iterable<T>): Pipeline<T> {
    async function* source() { yield* iter; }
    return new Pipeline(this, source());
  }

  private enqueueWork(key: string | number, work: WorkItem) {
    if (!this.processors[key]) {
      this.processors[key] = {
        activeWorkers: 0,
        limiter: (this.opts?.rateLimit) ? getLimiter(this.opts.rateLimit) : null,
        queue: [work]
      };
    } else {
      this.processors[key]!.queue.push(work);
      this.processors[key]?.queue.sort((a, b) => b.priority - a.priority);
    }
    if (this.processors[key]!.activeWorkers < this.maxConcurrency) {
      void this.startProcessor(key);
    }
  }

  private async startProcessor(key: string | number) {
    const processor = this.processors[key];
    if (!processor) return;
    processor.activeWorkers += 1;

    let nextWork: WorkItem | undefined;
    while (nextWork = processor.queue.shift()) {
      const {task, resolve, reject} = nextWork;
      try {
        if (processor.limiter) await processor.limiter.next();
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

class ProcessorWithOpts implements QueueProcessor {
  private opts: ProcessOpts = {};
  constructor(opts: ProcessOpts, private parentProcessor: AsyncQueueProcessor) {
    Object.assign(this.opts, opts);
  }

  data<T>(iter: Iterable<T>): Pipeline<T> {
    async function* source() { yield* iter; }
    return new Pipeline(this, source());
  }

  public pipe(child: QueueProcessor) {
    return new PipedProcessor(this, child);
  }

  public with(opts: ProcessOpts) {
    return new ProcessorWithOpts(opts, this.parentProcessor);
  }

  public processMany<T>(tasks: (() => Promise<T>)[]): Promise<T[]> {
    return this.parentProcessor.processManyWith(tasks, this.opts)
  }

  public process<T>(task: () => Promise<T>): Promise<T> {
    return this.parentProcessor.processWith(task, this.opts)
  }
}

class PipedProcessor implements QueueProcessor {
  constructor(private parentProcessor: QueueProcessor, private childProcessor: QueueProcessor) { }

  data<T>(iter: Iterable<T>): Pipeline<T> {
    async function* source() { yield* iter; }
    return new Pipeline(this, source());
  }

  public pipe(child: QueueProcessor) {
    return new PipedProcessor(this, child);
  }

  public process<T>(task: () => Promise<T>): Promise<T> {
    return this.parentProcessor.process(() => {
      return this.childProcessor.process(task);
    })
  }

  generate<T>(): AsyncGenerator<T, any, unknown> {
    throw new Error('Method not implemented.');
  }
}

type predicate<T> = (element: T, index?: number) => Promise<boolean>;
type syncPredicate<T> = (element: T, index?: number) => boolean;
type mapper<T, E> = (element: T, index?: number) => Promise<E>;
type syncMapper<T, E> = (element: T, index?: number) => E;
type flatmapper<T, E> = (element: T, index?: number) => Promise<E[]>;
type syncFlatmapper<T, E> = (element: T, index?: number) => E[];
type func<T> = (element: T, index?: number) => any;

export class Pipeline<T> {

  private scatterCount: number;
  private index = 0;

  public constructor(private parent: QueueProcessor, private data: AsyncGenerator<T>, scatterCount?: number) {
    this.scatterCount = scatterCount ?? 1;
  }

  async toArray(): Promise<T[]> {
    const arr = [];
    for await (const d of this.data) {
      arr.push(d);
    }
    return arr;
  }

  nextProcessor<E>(data: AsyncGenerator<E>) {
    return new Pipeline<E>(this.parent, data, this.scatterCount);
  }

  pipe(nextProcessor: QueueProcessor) {
    return new Pipeline(nextProcessor, this.data);
  }

  scatter(count: number) {
    this.scatterCount = count;
    return this;
  }

  gather() {
    this.scatterCount = 1;
    return this;
  }

  filter(predicate: predicate<T>) {
    return this.nextProcessor(this._scatter(() => this._filter(predicate)));
  }

  filterSync(predicate: syncPredicate<T>) {
    return this.nextProcessor(this._filterSync(predicate));
  }

  map<E>(mapper: mapper<T, E>) {
    return this.nextProcessor(this._scatter(() => this._map(mapper)));
  }

  mapSync<E>(mapper: syncMapper<T, E>) {
    return this.nextProcessor(this._mapSync(mapper));
  }

  flatMap<E>(flatMapper: flatmapper<T, E>) {
    return this.nextProcessor(this._scatter(() => this._flatMap(flatMapper)));
  }

  flatMapSync<E>(flatMapper: syncFlatmapper<T, E>) {
    return this.nextProcessor(this._flatMapSync(flatMapper));
  }

  forEach(func: func<T>) {
    return this.nextProcessor(this._scatter(() => this._forEach(func)));
  }

  forEachSync(func: func<T>) {
    return this.nextProcessor(this._forEachSync(func));
  }

  take(count: number) {
    return this.nextProcessor(this._scatter(() => this._take(count)));
  }

  skip(count: number) {
    return this.nextProcessor(this._scatter(() => this._skip(count)));
  }

  async execute() {
    for await (const _ of this.data) {}
  }

  private _scatter<T>(source: () => AsyncGenerator<T>): AsyncGenerator<T> {
    if (this.scatterCount === 1) {
      return source();
    }
    const generators: AsyncGenerator<T>[] = [];
    for (let i = 0; i < this.scatterCount; i++) {
      generators.push(source());
    }
    return this.combine(generators);
  }

  /**
   * Combine the output of multiple async generators
   */
  private async* combine<T>(generators: AsyncGenerator<T>[]): AsyncGenerator<T> {
    const toPromise = (origin: AsyncGenerator<any>) =>
      ({ origin, promise: origin.next().then(result => ({origin, result}))});

    let sources = generators.map(toPromise);
    while(sources.length > 0) {
      // Get next available value.
      const next = await Promise.race(sources.map(s => s.promise));
      // Remove from sources.
      sources = sources.filter(s => s.origin !== next.origin);
      if (!next.result.done) {
        // If more to come, add back to sources.
        sources.push(toPromise(next.origin));
        yield next.result.value;
      }
    }
  }

  private async* _filter(predicate: (element: T, index?: number) => Promise<boolean>) {
    for await (const element of this.data) {
      if (await this.parent.process(() => predicate(element, this.index++))) {
        yield element;
      }
    }
  }

  private async* _filterSync(predicate: syncPredicate<T>) {
    for await (const element of this.data) {
      if (predicate(element, this.index++)) {
        yield element;
      }
    }
  }

  private async* _map<E>(mapper: mapper<T, E>) {
    for await (const element of this.data) {
      yield await this.parent.process(() => mapper(element, this.index++));
    }
  }

  private async* _mapSync<E>(mapper: syncMapper<T, E>) {
    for await (const element of this.data) {
      yield mapper(element, this.index++);
    }
  }

  private async* _flatMap<E>(flatMapper: flatmapper<T, E>) {
    for await (const element of this.data) {
      yield* await this.parent.process(() => flatMapper(element, this.index++));
    }
  }

  private async* _flatMapSync<E>(flatMapper: syncFlatmapper<T, E>) {
    for await (const element of this.data) {
      yield* flatMapper(element, this.index++);
    }
  }

  private async* _forEach(func: (element: T, index?: number) => Promise<any>) {
    for await (const element of this.data) {
      this.parent.process(() => func(element, this.index++));
      yield element;
    }
  }

  private async* _forEachSync(func: (element: T, index?: number) => any) {
    for await (const element of this.data) {
      func(element, this.index++);
      yield element;
    }
  }

  private async* _take(count: number) {
    for (let i = 0; i < count; i++) {
      const next = await this.data.next();
      yield next.value;
      if (next.done === true) {
        break;
      }
    }
  }

  private async* _skip(count: number) {
    for (let i = 0; i < count; i++) {
      const next = await this.data.next();
      if (next.done === true) {
        break;
      }
    }
    yield* this.data;
  }

  private async* _takeWhile(predicate: (element: T, index?: number) => Promise<boolean>) {
    while(true) {
      const next = await this.data.next();
      const passes = await this.parent.process(() => predicate(next.value));
      if (passes) {
        yield next.value;
      }
      if (next.done === true) {
        break;
      }
    }
  }
}

type limiter = AsyncGenerator<void, void, void>;
// Rate limiting in token bucket style.
async function* getLimiter(opts: LimiterOpts): limiter {
  let slots = 1;
  let maxSlots = 1;
  let fillRate: number;
  let prevFill = performance.now();

  const limit = opts.limit[0];
  if (opts.limit[1] === 'second') {
    fillRate = 1000 / limit;
  } else {
    fillRate = 1000 * 60 / limit;
  }

  const tickRate = opts.tickRate ?? 0;
  if (opts.burst) {
    slots = limit;
    maxSlots = opts.burstSlots ?? limit;
  }

  function fillSlots() {
    const now = performance.now();
    const newSlots = Math.floor((now - prevFill) / fillRate);
    if (newSlots > 0) {
      slots = Math.min(slots + newSlots, maxSlots);
      prevFill = now;
    }
  }

  while(true) {
    while (slots > 0) {
      yield;
      slots -= 1;
    }
    // Bucket ran out, sleep a bit and try to refill.
    await sleep(tickRate);
    fillSlots();
  }
}

async function sleep(ms: number) {
  return new Promise(res => setTimeout(res, ms));
}