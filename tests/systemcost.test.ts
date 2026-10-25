import {Type} from '../src/type';
import {System} from '../src/system';
import {World} from '../src/world';

// The price of a system per frame, measured against a world without it. ase generates one client
// system per component of a module, and ase-gis carries 2380 components, so the price of a system
// whose change query saw nothing decides whether that form fits into a frame.

const TYPE_COUNT = 2380;
const WRITTEN_PER_FRAME = 7;
const WARMUP_FRAMES = 60;
const MEASURED_FRAMES = 600;

function makeTypes(count: number) {
  return Array.from({length: count}, () => class {
    static schema: any = {value: Type.int32};
  });
}

function makeWatchers(types: any[]) {
  return types.map(type => class extends System {
    entities = this.query(q => q.changed.with(type).read.trackWrites);
    execute() {
      for (const entity of this.entities.changed) entity.read(type);
    }
  });
}

function makeWriter(types: any[]) {
  const written = types.slice(0, WRITTEN_PER_FRAME);
  return class extends System {
    entities = this.query(q => q.current.with(written[0]).write.using(...written).write);
    execute() {
      for (const entity of this.entities.current) {
        for (const type of written) (entity.write(type) as {value: number}).value += 1;
      }
    }
  };
}

async function frameMedian(withWatchers: boolean): Promise<number> {
  const types = makeTypes(TYPE_COUNT);
  const defs: any[] = [...types, makeWriter(types)];
  if (withWatchers) defs.push(...makeWatchers(types));
  const world = await World.create({defs, maxEntities: 100, maxShapeChangesPerFrame: 100000});
  world.build(sys => {
    sys.createEntity(...types.slice(0, WRITTEN_PER_FRAME).flatMap(type => [type, {value: 0}]));
  });
  for (let i = 0; i < WARMUP_FRAMES; i++) await world.execute();
  const times: number[] = [];
  for (let i = 0; i < MEASURED_FRAMES; i++) {
    const start = performance.now();
    await world.execute();
    times.push(performance.now() - start);
  }
  await world.terminate();
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

describe('system cost', () => {
  test('price of one system per component whose change query saw nothing', async () => {
    const without = await frameMedian(false);
    const withWatchers = await frameMedian(true);
    const perSystemUs = (withWatchers - without) * 1000 / TYPE_COUNT;
    console.log(
      `[systemcost] ${TYPE_COUNT} types, ${WRITTEN_PER_FRAME} written per frame: ` +
      `median ${without.toFixed(3)} ms without watchers, ${withWatchers.toFixed(3)} ms with ` +
      `${TYPE_COUNT} watchers, ${perSystemUs.toFixed(2)} us per system and frame`);
    expect(withWatchers).toBeGreaterThan(0);
  }, 600000);
});
