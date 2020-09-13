import { AsyncQueueProcessor, Pipeline } from './src/AsyncQueueProcessor';

function sleep () {
  return new Promise(res => setTimeout(res, Math.random() * 2000 + 1000));
}

async function testing() {

  // console.log(await a.toArray());
  const p1 = Pipeline.from([1,2,3])
  .map(async (el) => {
    await sleep();
    return el;
  })

  const p2 = Pipeline.from(['a','b','c','d'])
  .map(async (el) => {
    await sleep()
    return el
  })
  .chunk(2)

  const p3 = Pipeline.from([false, true, false, true, false, true, false, true, false])
  .chunk(2)
  .map(async (el) => {
    await sleep()
    return el;
  });

  const foo = Pipeline
    .interleave(p1, p2, p3)
    .forEach((el) => {
      console.log(el);
    }).execute();

  return;


  // maxConcurrency = 1 aka critical section.
  // const criticalSectionProcessor = new AsyncQueueProcessor({
  //   maxConcurrency: 1,
  //   maxPending: 100
  // });

  // const results = await criticalSectionProcessor.processMany([
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

//   console.log('---------- concurrency ----------');
//   const concurrentProcessor = new AsyncQueueProcessor({
//     maxConcurrency: 5,
//     maxPending: 1000
//   });

//   await Promise.all([...Array(100)].map((_, i) => {
//     const id = (i % 3);
//     const gutter = '               '.repeat(id);
//     return concurrentProcessor.process(async () => {
//       await doWork(`${gutter}${i.toString().padEnd(2, ' ')}`)
//     });
//   }));
//   console.log('---------------------------------');
//   console.log();
}

testing()
  .then(() => {})
  .catch(err => console.log('err', err));