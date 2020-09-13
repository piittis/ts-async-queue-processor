import { Readable } from 'stream';
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

type task<T> = () => Promise<T>;

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

  public pipelineAsync<T>(iterable: AsyncIterable<T>): Pipeline<T> {
    return new Pipeline(iterable);
  }

  public pipeline<T>(iterable: Iterable<T>): Pipeline<T> {
    async function* source() { yield* iterable; }
    return new Pipeline(source());
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

type pipelineUnion<T extends Pipeline<any>[]> = T[number] extends Pipeline<infer R> ? R : T

class ProcessorWithOpts implements QueueProcessor {
  private opts: ProcessOpts = {};
  constructor(opts: ProcessOpts, private parentProcessor: AsyncQueueProcessor) {
    Object.assign(this.opts, opts);
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

  public pipe(child: QueueProcessor) {
    return new PipedProcessor(this, child);
  }

  public process<T>(task: () => Promise<T>): Promise<T> {
    return this.parentProcessor.process(() => {
      return this.childProcessor.process(task);
    })
  }
}

type predicate<T> = (element: T, index?: number) => Promise<boolean>;
type syncPredicate<T> = (element: T, index?: number) => boolean;
type mapper<T, E> = (element: T, index?: number) => Promise<E>;
type syncMapper<T, E> = (element: T, index?: number) => E;
type flatmapper<T, E> = (element: T, index?: number) => Promise<E[]>;
type syncFlatmapper<T, E> = (element: T, index?: number) => E[];
type func<T> = (element: T, index?: number) => any;

type maybeProcessor = QueueProcessor | null;
interface PipelineOpts {
  processor: maybeProcessor;
  scatterCount: number;
}

export class Pipeline<T> {

  private opts: PipelineOpts;
  private processor: maybeProcessor;
  private index = 0;

  public constructor(private data: AsyncIterable<T>, opts?: PipelineOpts) {
    this.opts = opts ?? { processor: null, scatterCount: 1 };
    this.processor = this.opts.processor;
  }

  public async toArray(): Promise<T[]> {
    const arr = [];
    for await (const d of this.data) {
      arr.push(d);
    }
    return arr;
  }

  public static from<E>(iterable: Iterable<E>) {
    async function* source() { yield* iterable; }
    return new Pipeline(source());
  }

  public static fromAsync<E>(AsyncIterable: AsyncIterable<E>) {
    return new Pipeline(AsyncIterable);
  }

  public static combine<E extends Pipeline<any>[]>(...pipelines: E): Pipeline<pipelineUnion<E>> {
    const sources = pipelines.map(p =>
      async function*() {
        yield* p.toIterable()
      }()
    );
    const source = this._combine(sources)
    return new Pipeline(source);
  }

  public static concat<E extends Pipeline<any>[]>(...pipelines: E): Pipeline<pipelineUnion<E>> {
    const source = async function*() {
      for (const pl of pipelines) {
        yield* pl.toIterable()
      }
    }
    return new Pipeline(source());
  }

  public static interleave<E extends Pipeline<any>[]>(...pipelines: E): Pipeline<pipelineUnion<E>> {
    let iterators = pipelines
      .map(pl => pl.toIterable()[Symbol.asyncIterator]());

    const source = async function*() {
      while(iterators.length > 0) {
        for (const origin of iterators) {
          const next = await origin.next();
          if (!next.done) {
            yield next.value;
          } else {
            iterators = iterators.filter(it => it !== origin);
          }
        }
      }
    }
    return new Pipeline(source());
  }

  public static zip<E extends Pipeline<any>[]>(...pipelines: E): Pipeline<pipelineUnion<E>[]> {
    let iterators = pipelines
      .map(pl => pl.toIterable()[Symbol.asyncIterator]());

    const source = async function*() {
      while(iterators.length > 0) {
        const buffer = [];
        for (const origin of iterators) {
          const next = await origin.next();
          if (!next.done) {
            buffer.push(next.value)
          } else {
            iterators = iterators.filter(it => it !== origin);
          }
        }
        if (buffer.length > 0) {
          yield buffer;
        }
      }
    }
    return new Pipeline(source());
  }

  public toIterable(): AsyncIterable<T> {
    return this.data;
  }

  public toStream(): Readable {
    return Readable.from(this.data);
  }

  public pipe(processor: QueueProcessor) {
    this.opts.processor = processor;
    this.processor = processor;
    return this;
  }

  public scatter(count: number) {
    this.opts.scatterCount = count;
    return this;
  }

  public gather() {
    this.opts.scatterCount = 1;
    return this;
  }

  public filter(predicate: predicate<T>) {
    return this._next(this._scatter(() => this._filter(predicate)));
  }

  public filterSync(predicate: syncPredicate<T>) {
    return this._next(this._filterSync(predicate));
  }

  public map<E>(mapper: mapper<T, E>) {
    return this._next(this._scatter(() => this._map(mapper)));
  }

  public mapSync<E>(mapper: syncMapper<T, E>) {
    return this._next(this._mapSync(mapper));
  }

  public flatMap<E>(flatMapper: flatmapper<T, E>) {
    return this._next(this._scatter(() => this._flatMap(flatMapper)));
  }

  public flatMapSync<E>(flatMapper: syncFlatmapper<T, E>) {
    return this._next(this._flatMapSync(flatMapper));
  }

  public forEach(func: func<T>) {
    return this._next(this._scatter(() => this._forEach(func)));
  }

  public forEachSync(func: func<T>) {
    return this._next(this._forEachSync(func));
  }

  public take(count: number) {
    return this._next(this._scatter(() => this._take(count)));
  }

  public skip(count: number) {
    return this._next(this._scatter(() => this._skip(count)));
  }

  public chunk(count: number) {
    return this._next(this._chunk(count))
  }

  public async execute() {
    for await (const _ of this.data) {}
  }

  private _next<E>(data: AsyncGenerator<E>) {
    return new Pipeline<E>(data, {...this.opts});
  }

  private async _process<E>(task: task<E>) {
    if (this.processor) {
      return this.processor.process(task);
    } else {
      return task();
    }
  }

  private _scatter<T>(source: () => AsyncGenerator<T>): AsyncGenerator<T> {
    if (this.opts.scatterCount === 1) {
      return source();
    }
    const generators: AsyncGenerator<T>[] = [];
    for (let i = 0; i < this.opts.scatterCount; i++) {
      generators.push(source());
    }
    return Pipeline._combine(generators);
  }

  /**
   * Combine the output of multiple async generators
   */
  public static async* _combine<T>(generators: AsyncGenerator<T>[]): AsyncGenerator<T> {

    const toPromise = (origin: AsyncGenerator<any>) =>
      ({ origin, promise: origin.next().then(result => ({origin, result}))});

    let sources = generators.map(toPromise);
    while(sources.length > 0) {
      // Get next available value from any source.
      const next = await Promise.race(sources.map(s => s.promise));
      // Remove the source that produced a value.
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
      if (await this._process(() => predicate(element, this.index++))) {
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
      yield await this._process(() => mapper(element, this.index++));
    }
  }

  private async* _mapSync<E>(mapper: syncMapper<T, E>) {
    for await (const element of this.data) {
      yield mapper(element, this.index++);
    }
  }

  private async* _flatMap<E>(flatMapper: flatmapper<T, E>) {
    for await (const element of this.data) {
      yield* await this._process(() => flatMapper(element, this.index++));
    }
  }

  private async* _flatMapSync<E>(flatMapper: syncFlatmapper<T, E>) {
    for await (const element of this.data) {
      yield* flatMapper(element, this.index++);
    }
  }

  private async* _forEach(func: (element: T, index?: number) => Promise<any>) {
    for await (const element of this.data) {
      this._process(() => func(element, this.index++));
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
    let taken = 0;
    for await (const element of this.data) {
      if (taken < count) {
        taken++;
        yield element;
      } else {
        break;
      }
    }
  }

  private async* _skip(count: number) {
    let skipped = 0;
    for await (const element of this.data) {
      if (skipped < count) {
        continue;
      } else {
        yield element;
      }
    }
  }

  private async* _takeWhile(predicate: (element: T, index?: number) => Promise<boolean>) {
    for await (const element of this.data) {
      if (await this._process(() => predicate(element))) {
        yield element;
      } else {
        break;
      }
    }
  }

  private async* _chunk(count: number) {
    let buffer: T[] = [];
    for await (const element of this.data) {
      buffer.push(element)
      if (buffer.length >= count) {
        yield buffer;
        buffer = [];
      }
    }
    if (buffer.length > 0) {
      yield buffer;
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
