import { AsyncQueueProcessor } from './src/AsyncQueueProcessor';

function sleep () {
  return new Promise(res => setTimeout(res, Math.random() * 2000 + 1000));
}

async function doWork(name: string) {
  console.log(name, ' start');
  await sleep();
  console.log(name, ' done');
}
// get file ids
// download stream for each file
// pipe into http request

async function testing() {

  const generator = new AsyncQueueProcessor({
    maxConcurrency: 5,
    maxPending: 100
  });

  const processor1 = new AsyncQueueProcessor({
    maxConcurrency: 5,
    maxPending: 100
  });

  const processor2 = new AsyncQueueProcessor({
    maxConcurrency: 5,
    maxPending: 100
  });


  const dbProcessor = new AsyncQueueProcessor({
    maxConcurrency: 10,
    // rateLimit: {limit: [15, 'second']}
  });

  const rowProcessor = new AsyncQueueProcessor({
    maxConcurrency: 1,
    // rateLimit: {limit: [5, 'second']}
  });

  generator
  .data([1,2,3,4,5,6,7,8,9])
  .pipe(processor1)
  .map(async () => {
    await doWork('map1');
  })
  .pipe(processor2)
  .map(async () => {
    await doWork('map2');
  })
  .execute();

  // await Promise.all([
  //   dbProcessor.pipe(rowProcessor.with({key: '1'})).process(() => doWork('1a')),
  //   dbProcessor.pipe(rowProcessor.with({key: '1'})).process(() => doWork('1b')),

  //   dbProcessor.pipe(rowProcessor.with({key: '2'})).process(() => doWork('2a')),
  //   dbProcessor.pipe(rowProcessor.with({key: '2'})).process(() => doWork('2b')),

  //   dbProcessor.pipe(rowProcessor.with({key: '3'})).process(() => doWork('3a')),
  //   dbProcessor.pipe(rowProcessor.with({key: '3'})).process(() => doWork('3b'))
  // ])


  // .map(async el => {
  //   await doWork(el.toString());
  //   return el*10
  // })
  // .forEach(el => console.log(el))
  // .execute()

  return

  // return;
  // .filter(async (el) => {
  //   await sleep()
  //   return el % 2 === 0;
  // })
  // .flatMap(async (el) => {
  //   await sleep();
  //   return [el, 'a'];
  // });



  // const odd = await new AsyncQueueProcessor({
  //   maxConcurrency: 1,
  //   maxPending: 100
  // })

  // odd.data([1,2,3,4,5,6,7,8,9,10])
  // .filter(async (el) => {
  //   await sleep()
  //   return el % 2 !== 0;
  // });

  // odd.data(even)
  // .f

  // const nums = new AsyncQueueProcessor({
  //   maxConcurrency: 1,
  //   maxPending: 100
  // })

  // maxConcurrency = 1 aka critical section.
  // console.log('---------- critical section ----------');
  // const criticalSectionProcessor = new AsyncQueueProcessor({
  //   maxConcurrency: 1,
  //   maxPending: 100
  // });

  // const results = await criticalSectionProcessor.processMany('id1', [
  //   () => doWork('a'),
  //   () => doWork(' b'),
  //   () => doWork('  c')
  // ]);

  // await Promise.all([...Array(30)].map((_, i) => {
  //   const id = (i % 3);
  //   const gutter = '               '.repeat(id);
  //   return criticalSectionProcessor.process(id.toString(), async () => doWork(`${gutter}${i.toString().padEnd(2, ' ')}`));
  // }));
  // console.log('--------------------------------------');
  // console.log()

  // console.log('---------- concurrency ----------');
  // const concurrentProcessor = new AsyncQueueProcessor({
  //   maxConcurrency: 5,
  //   maxPending: 1000
  // });

  // await Promise.all([...Array(100)].map((_, i) => {
  //   const id = (i % 3);
  //   const gutter = '               '.repeat(id);
  //   return concurrentProcessor.process(id.toString(), async () => {
  //     await doWork(`${gutter}${i.toString().padEnd(2, ' ')}`)
  //   });
  // }));
  // console.log('---------------------------------');
  // console.log();
}

testing()
  .then(() => {})
  .catch(err => console.log('err', err));