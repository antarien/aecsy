import {component, field, System, type SystemType, World} from '../src';


@component class A {
  @field.int32 declare value: number;
}

@component class B {
  @field.int32 declare value: number;
}


let runs = 0;
let seen = 0;
let present = 0;

class WriteA extends System {
  static active = false;
  entities = this.query(q => q.current.with(A).write);
  execute() {
    if (!WriteA.active) return;
    for (const entity of this.entities.current) entity.write(A).value += 1;
  }
}

class WriteB extends System {
  entities = this.query(q => q.current.with(B).write);
  execute() {
    for (const entity of this.entities.current) {
      for (let i = 0; i < 5; i++) entity.write(B).value += 1;
    }
  }
}

class WatchAOnChanges extends System {
  sked = this.schedule(s => s.after(WriteA, WriteB).onlyOnChanges);
  entities = this.query(q => q.changed.with(A).read.trackWrites);
  execute() {
    runs += 1;
    seen += this.entities.changed.length;
  }
}

class WatchAEveryFrame extends System {
  sked = this.schedule(s => s.after(WriteA, WriteB));
  entities = this.query(q => q.changed.with(A).read.trackWrites);
  execute() {
    runs += 1;
    seen += this.entities.changed.length;
  }
}

class WatchABeforeWriter extends System {
  sked = this.schedule(s => s.before(WriteA).onlyOnChanges);
  entities = this.query(q => q.changed.with(A).read.trackWrites);
  execute() {
    runs += 1;
    seen += this.entities.changed.length;
  }
}

class CountAOnChanges extends System {
  sked = this.schedule(s => s.onlyOnChanges);
  entities = this.query(q => q.current.with(A).read);
  execute() {
    present = this.entities.current.length;
  }
}


async function createWorld(...systems: SystemType<System>[]): Promise<World> {
  runs = 0;
  seen = 0;
  present = 0;
  WriteA.active = false;
  return World.create({
    maxEntities: 100, maxWritesPerFrame: 20, defaultComponentStorage: 'sparse', defs: [systems]
  });
}


describe('systems that run only on changes', () => {

  test('runs in the first frame, then only after its type was written', async () => {
    const world = await createWorld(WriteA, WriteB, WatchAOnChanges);
    world.createEntity(A, B);
    await world.execute();
    const afterFirst = runs;
    for (let i = 0; i < 10; i++) await world.execute();
    expect(afterFirst).toBe(1);
    expect(runs).toBe(afterFirst);
    WriteA.active = true;
    await world.execute();
    expect(runs).toBe(afterFirst + 1);
    expect(seen).toBe(1);
  });

  test('a system without the flag still runs in every frame', async () => {
    const world = await createWorld(WriteA, WriteB, WatchAEveryFrame);
    world.createEntity(A, B);
    for (let i = 0; i < 11; i++) await world.execute();
    expect(runs).toBe(11);
  });

  test('sees a change after sleeping through more writes than the log holds', async () => {
    const world = await createWorld(WriteA, WriteB, WatchAOnChanges);
    world.createEntity(A, B);
    for (let i = 0; i < 100; i++) await world.execute();
    WriteA.active = true;
    await world.execute();
    expect(seen).toBe(1);
  });

  test('woken by a later system, it runs in the next frame and sees the change', async () => {
    const world = await createWorld(WriteA, WatchABeforeWriter);
    world.createEntity(A);
    await world.execute();
    const afterFirst = runs;
    await world.execute();
    expect(runs).toBe(afterFirst);
    WriteA.active = true;
    await world.execute();
    expect(runs).toBe(afterFirst);
    WriteA.active = false;
    await world.execute();
    expect(runs).toBe(afterFirst + 1);
    expect(seen).toBe(1);
  });

  test('a current query follows entities added while the system slept', async () => {
    const world = await createWorld(WriteB, CountAOnChanges);
    world.createEntity(B);
    for (let i = 0; i < 5; i++) await world.execute();
    expect(present).toBe(0);
    world.createEntity(A);
    world.createEntity(A);
    await world.execute();
    expect(present).toBe(2);
  });

});
