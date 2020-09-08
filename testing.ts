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

  const generator = new AsyncQueueProcessor({
    maxConcurrency: 100,
    maxPending: 100,
    rateLimit: {
      limit: [1, 'second']
    }
  });

  const processor1 = new AsyncQueueProcessor({
    maxConcurrency: 20,
    maxPending: 100,
  });

  const a = processor1
  .data([1,2,3,4,5,6,7,8,9])
  .scatter(5)
  .map(async(el) => {
    await sleep();
    return el;
  })
  // .gather()
  .forEach((el) => {
    console.log('forEach', el);
  })

  console.log(await a.toArray());

  // const b = processor1
  // .data([1,2,3,4,5,6,7,8,9])
  // .map(async(el) => {
  //   await sleep();
  //   return 'p2 - ' + el.toString()
  // })

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