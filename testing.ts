import { AsyncQueueProcessor } from './src/AsyncQueueProcessor';

function sleep () {
  return new Promise(res => setTimeout(res, Math.random() * 2000 + 1000));
}

async function doWork(name: string) {
  console.log(name, ' start');
  await sleep();
  console.log(name, ' done');
}

async function testing() {

  // maxConcurrency = 1 aka critical section.
  console.log('---------- critical section ----------');
  const criticalSectionProcessor = new AsyncQueueProcessor({
    maxConcurrency: 1,
    maxPending: 100
  });

  const results = await criticalSectionProcessor.processMany('id1', [
    () => doWork('a'),
    () => doWork(' b'),
    () => doWork('  c')
  ]);

  await Promise.all([...Array(30)].map((_, i) => {
    const id = (i % 3);
    const gutter = '               '.repeat(id);
    return criticalSectionProcessor.process(id.toString(), async () => doWork(`${gutter}${i.toString().padEnd(2, ' ')}`));
  }));
  console.log('--------------------------------------');
  console.log()

  console.log('---------- concurrency ----------');
  const concurrentProcessor = new AsyncQueueProcessor({
    maxConcurrency: 5,
    maxPending: 1000
  });

  await Promise.all([...Array(100)].map((_, i) => {
    const id = (i % 3);
    const gutter = '               '.repeat(id);
    return concurrentProcessor.process(id.toString(), async () => {
      await doWork(`${gutter}${i.toString().padEnd(2, ' ')}`)
    });
  }));
  console.log('---------------------------------');
  console.log();
}

testing()
  .then(() => {})
  .catch(err => console.log('err', err));