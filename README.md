# Async Queue Processor
(status: experimental)

Simple yet powerful tool for async operations. Constructs provided are `Processor` and `Pipeline`.

## Processor
A Construct that allows executing async functions while placing constraints on concurrency, throughput and allowed amount of pending functions.

### Examples

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
const externalApiProcessor = new AsyncQueueProcessor({
  concurrency: 5,
  rateLimit: {
    limit: [5, 'second']
  }
});

function send(data) {
  externalApiProcessor.process(async() => {
    await sendData(data);
  })
}
```
**Example 3**: Processor lanes. You can provide a `key` value. Each key is processed in a seperate "lane". Processing contraints are applied to each lane seperately. `with` can be used to create a new processor that will do all processing using the given key.
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

## Pipeline
A Construct that allows data flow through various async functions.
### Usage examples
**Example 1**: simple illustration.
```typescript
await Pipeline.from(persons)
  .map(async (person) => {
    return {person, extra: await getExtraInfo(person)};
  })
  .filter((e) => isValid(e.person, e.extra))
  .forEach(async (e) => {
    await sendData(e.person, e.extra);
    await setAsProcessed(e.person);
  }).execute();
```

**Example 2**: Concurrency.

Pipeline functions are evaluated lazily, and each element flows though one at a time from start to finish. By default there is no concurrency within a single pipeline. Concurrency can be achieved using `scatter` and `gather`.

- `scatter(n: number)`
  - Has the effect, that `n` amount of generators are spawned to concurrently produce the results of the pipeline functions. The output of the generators is combined for consumption by the downstream.
  - Scattering allows different pipeline stages to be active concurrently, thus speeding up processing overall.
  - If some function is slow while others are fast, the slow function can be scattered to remedy the bottleneck.
  - When downstream asks for the next value, a scattered function will eagerly start producing up to `n` values concurrently, thus effectively creating a buffer of `n` slots for the values. Values flow forward as soon as they are ready, thus element ordering is not guaranteed after scattering.
- `scatterOrdered(n: number)`
  - Same as scatter, but element order is preserved. Data flow is a bit more choppy, as the pipeline must block to wait for a value sometimes, even though subsequent values might already be ready to go.
- `gather`
  - will remove any scattering effect for the pipeline stages that follow it.

Filter and map stages are processed with max concurency of 5:
```typescript
await Pipeline.from(data)
  .scatter(5)
  .filter(validate)
  .map(augment)
  .gather()
  .forEach(consume)
  .execute()
```
**Example 3**: Various combinators can be used to derive pipelines from other ones.
```typescript
const numbers = Pipeline.from([1, 2, 3]);
const strings = Pipeline.from(['a', 'b', 'c']);

// Produces all values of pipelines in arbitrary order.
Pipeline.combine(numbers, strings)

// Produces 1, 2, 3, 'a', 'b', 'c'.
Pipeline.concat(numbers, strings)

// Produces 1, 'a', 2, 'b', 3, 'c'.
Pipeline.interleave(numbers, strings)

// Produces [1, 'a'], [2, 'b'], [3, 'c'].
Pipeline.zip(numbers, strings)
```

## Combining Processor and Pipeline

`Processor` and `Pipeline` are nice and all, but why are they in the same library? The reason is, that they can be made to work together in useful ways.

**Example 1**: `pipe` can be used to transfer the processing of pipeline stages to a processor. Making all pipeline stages adhere to the constraints of the processor. Spawn many concurrent pipeline executions, while making sure no more than 5 concurrent operations are happening at any time:
```typescript
const processor = new AsyncQueueProcessor({concurrency: 5});

async function spawn(data) {
  await Pipeline.from(data)
    .pipe(processor)
    .filter(validate)
    .map(augment)
    .forEach(consume)
    .execute();
}
```

**Example 1**: Many processors in a single pipeline.
```typescript
const producer = new AsyncQueueProcessor({concurrency: 5});
const transformer = new AsyncQueueProcessor({concurrency: 10});
const consumer = new AsyncQueueProcessor({concurrency: 5});

Pipeline.fromAsync(async function*() {
  while(await haveMoreJobs()) {
    yield await getNextJobId();
  }
}())
.pipe(producer)
.map(getJobContext)
.pipe(transformer)
.filter(validateJob)
.map(processJob)
.pipe(consumer)
.forEach(consumeFinishedJob)
.execute();
```