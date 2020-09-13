# Async Queue Processor
(status: experimental)

Simple but powerful tool for async operations. Constructs provided are `Processor` and `Pipeline`.

## Processor
A Construct that allows executing async functions while placing constraints on concurrency, throughput and allowed amount of pending functions.

### Usage examples

**Example 1**: Critical section (concurrency = 1).
```typescript
const dataProcessor = new AsyncQueueProcessor({ concurrency: 1 });

// Transform data and return new state.
function processData() {
  return dataProcessor.process(async() => {
    const data = await getData();
    const newData = await transformData(data);
    await saveData(newData);
    return newData;
  })
}
```

**Example 2**: Allow 5 concurrent operations with throughput limited to 5 operations per second.
```typescript
const outgoingData = new AsyncQueueProcessor({
  concurrency: 5,
  rateLimit: {
    limit: [5, 'second']
  }
});

function send() {
  outgoingData.process(async() => {
    const data = await getData();
    await sendData(data);
  })
}
```
**Example 3**: Processor lanes. You can provide a `key` value. Each key is processed in a seperate processing "lane". Processing contraints are applied to each lane seperately. `with` can be used to create a new processor that will do all processing using the given key.
```typescript
const tableProcessor = new AsyncQueueProcessor({concurrency: 1});
function processRow(rowId: number) {
  // Only one concurrent access per row.
  tableProcessor.with({key: rowId}).process(async () => {
    await doRowTransform(rowId);
  });
}
```
Alternatively, key can be supplied to `processWith`, Following is equivalent to above.
```typescript
const tableProcessor = new AsyncQueueProcessor({concurrency: 1});
function processRow(rowId: number) {
  tableProcessor.processWith(async () => {
    await transformRow(rowId);
  }, {key: rowId});
}
```


**Example 4**: Processors can be combined with `pipe` to make a function adhere to many different constraints at the same time.

```typescript
const dbProcessor = new AsyncQueueProcessor({concurrency: 20});
const collectionProcessor = new AsyncQueueProcessor({concurrency: 10});
const documentProcessor = new AsyncQueueProcessor({concurrency: 1});

function processDocument(collectionName: string, documentId: string) {
  return dbProcessor
  .pipe(collectionProcessor.with({key: collectionName}))
  .pipe(documentProcessor.with({key: documentId}))
  .process(async () => {
    const state = await transformDocument(collection, documentId);
    return state;
  })
}
```

The above is equivalent to the following:
```typescript
function processDocument(collection: string, documentId: string) {
  return dbProcessor.process(() =>
    collectionProcessor.with({key: collection}).process(() =>
      documentProcessor.with({key: documentId}).process(async () => {
        const state = await transformDocument(collection, documentId);
        return state;
      })
    )
  )
}
```
### Main API

#### `constructor(opts: ProcessorOpts)`
``` typescript
interface ProcessorOpts {
  // Maximum allowed concurrency.
  concurrency?: number;
  // Maximum amount of pending tasks.
  maxPending?: number;
  rateLimit?: {
    // Throughput limit. n / second or n / minute.
    limit: [number, 'second' | 'minute'],
    // Tickrate of the limiter in millisecond. When rate limit is used up,
    // this defines how often the limiter will try to open up a new slot.
    // default = 0
    tickRate?: number;
    // Allow bursting. When true, up to <burstSlots> operations
    // can burst immediately, each using up one slot.
    // default = false
    burst?: boolean;
    // Maximum amount of slots for bursting.
    // Slots are regenerated using the specified rate limit.
    // default = same as rateLimit.limit[0]
    burstSlots?: number;
  }
}
```

#### `process<T>(task: () => Promise<T>): Promise<T>`
Processes a given async function. The promise returned by process will resolve with the same value as the given function.

#### `processWith<T>(task: () => Promise<T>, opts?: ProcessOpts): Promise<T>`
Processes a given async function using given options.
```typescript
interface ProcessOpts {
  key?: string | number;
  proprity?: number;
}
```
#### `processMany<T>(tasks: Array<() => Promise<T>>): Promise<T[]>`
Processes multiple tasks. Will resolve when all tasks are finished.

#### `with(opts: ProcessOpts)`
Returns a subprocessor, with given options. Each function will be processed using those options.

#### `data<T>(iter: Iterable<T>): Pipeline<T>`
Initialize a new pipeline using an Iterable as data source.

#### `generate<T>(iter: AsyncGenerator<T>): Pipeline<T>`
Initialize a new pipeline using an AsyncGenerator as data source.

## Pipeline
A Construct that allows piping data through different async function. These functions are processed using a specified processor, thus adhering to concurrency and rate limiting constraints.

### Usage examples
**Example 1**: simple illustration.
```typescript
const personProcessor = new AsyncQueueProcessor({concurrency: 1});
await personProcessor
  .data(persons)
  .map(async (person) => {
    return {person, extra: await getExtraInfo(person)};
  })
  .filter((e) => isValid(e.person, e.extra))
  .forEach(async (e) => {
    await sendData(e.person, e.extra);
    await setAsProcessed(e.person);
  })
  .execute();
```

**Example 2**: Multiple processors. A pipeline can use `pipe` to move the execution to a different processor. Different sections of the pipeline can be executed using different processors.
```typescript
const producer = new AsyncQueueProcessor({concurrency: 10});
const transformer = new AsyncQueueProcessor({concurrency: 10});
const consumer = new AsyncQueueProcessor({concurrency: 10});

producer.generate(async function* () {
  let item;
  while (item = await getNextItem()) {
    yield item;
  }
}())
.pipe(transformer)
.map(async (item) =>  {
  return {
    item,
    params: await getJobParams()
  };
})
.filter(isValid)
.pipe(consumer)
.forEach(async (item) => {
  await consumeItem(item)
}).execute();
```

**Example 3**: Concurrency.

Pipeline functions are evaluated lazily, and each element flows though one at a time from start to finish. By default there is no concurrency within a single pipeline. You can spawn multiple pipelines that can execute concurrently, while adhering to the concurrency constraints of the specified processor. Another option is to use `scatter` and `gather`.

- `scatter(n: number)` will have the effect, that `n` amount of generators are spawned to produce the results of the pipeline functions that follow it. The output of the generators is combined and passed downstream. Scattering allows different pipeline functions to be active concurrently, thus speeding up processing overall. If some function is slow while others are fast, the slow function can be scattered to remedy the bottleneck. Scattering a function effectively creates a buffer of `n` slots for the results of that function. Element ordering is not guaranteed after scatter.
- `gather` will remove any scattering effect for the pipeline functions that follow it.
```typescript
const a = await generator
  .data(incomingData)
  .pipe(transformer)
  .scatter(5)
  .filter(validate)
  .map(augment)
  .gather()
  .pipe(consumer)
  .forEach(consume)
  .execute()
```