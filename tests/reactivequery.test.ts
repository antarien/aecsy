import {component, type ComponentType, field, Query, System, type SystemType, World} from '../src';


@component class A {
  @field.uint8 declare value: number;
}

@component class B {
  @field.uint8 declare value: number;
}


class IncrementAddedAEarly extends System {
  sked = this.schedule(s => s.beforeWritersOf(A));
  entities = this.query(q => q.added.with(A).write);
  execute() {
    for (const entity of this.entities.added) entity.write(A).value += 1;
  }
}

class IncrementAddedALate extends System {
  sked = this.schedule(s => s.afterWritersOf(A));
  entities = this.query(q => q.added.with(A).write);
  execute() {
    for (const entity of this.entities.added) entity.write(A).value += 1;
  }
}

class IncrementBWithRemovedA extends System {
  entities = this.query(q => q.removed.with(A).read.and.with(B).write);
  execute() {
    for (const entity of this.entities.removed) entity.write(B).value += 1;
  }
}

class IncrementBWithChangedA extends System {
  sked = this.schedule(s => s.before(IncrementAddedALate));
  entities = this.query(q => q.changed.with(A).read.trackWrites.and.with(B).write);
  execute() {
    for (const entity of this.entities.changed) entity.write(B).value += 1;
  }
}

class CreateA extends System {
  entities = this.query(q => q.with(A).write);

  execute() {
    this.createEntity(A);
  }
}

class RemoveA extends System {
  sked = this.schedule(s => s.after(IncrementBWithRemovedA));
  entities = this.query(q => q.current.with(A).write);
  execute() {
    for (const entity of this.entities.current) entity.remove(A);
  }
}


let total: {[key: string]: number} = {a: 0, b: 0};

class Count extends System {
  private readonly items: {[key: string]: {type: ComponentType<any>, query: Query}} = {
    a: {type: A, query: this.query(q => q.current.with(A))},
    b: {type: B, query: this.query(q => q.current.with(B))},
  };

  execute() {
    total = {a: 0, b: 0};
    for (const key in this.items) {
      for (const entity of this.items[key].query.current) {
        total[key] += entity.read(this.items[key].type).value;
      }
    }
  }
}

async function createWorld(...systems: SystemType<System>[]): Promise<World> {
  return World.create({
    maxEntities: 100, defaultComponentStorage: 'sparse', defs: [systems, Count]
  });
}


describe('added queries', () => {

  test('finds entities added before world executes', async () => {
    const world = await createWorld(IncrementAddedAEarly);
    world.createEntity(A);
    world.createEntity(A, B);
    world.createEntity(B);
    await world.execute();
    await world.execute();
    await world.execute();
    expect(total.a).toBe(2);
    expect(total.b).toBe(0);
  });

  test('finds entities added during frame', async () => {
    const world = await createWorld(CreateA, IncrementAddedALate);
    await world.execute();
    await world.execute();
    await world.execute();
    expect(total.a).toBe(3);
    expect(total.b).toBe(0);
  });

  test('finds entities added during previous frame', async () => {
    const world = await createWorld(IncrementAddedAEarly, CreateA);
    await world.execute();
    await world.execute();
    await world.execute();
    expect(total.a).toBe(2);
    expect(total.b).toBe(0);
  });

});


describe('removed queries', () => {
  test('finds removed entities', async () => {
    const world = await createWorld(IncrementBWithRemovedA, RemoveA);
    world.createEntity(A);
    world.createEntity(A, B);
    world.createEntity(A, B);
    world.createEntity(B);
    await world.execute();
    await world.execute();
    await world.execute();
    expect(total.a).toBe(0);
    expect(total.b).toBe(2);
  });
});


describe('changed queries', () => {

  test('finds changed entities', async () => {
    const world = await createWorld(IncrementBWithChangedA, IncrementAddedALate);
    world.createEntity(A);
    world.createEntity(A, B);
    world.createEntity(B);
    await world.execute();
    await world.execute();
    await world.execute();
    expect(total.a).toBe(2);
    expect(total.b).toBe(1);
  });

});


let typeStep: 'none' | 'writeA' | 'addB' | 'removeB' = 'none';
let typeSeen: {a: boolean, b: boolean, any: boolean} = {a: false, b: false, any: false};

class StepTypes extends System {
  entities = this.query(q => q.current.with(A).write.and.using(B).write);
  execute() {
    for (const entity of this.entities.current) {
      if (typeStep === 'writeA') entity.write(A).value += 1;
      if (typeStep === 'addB' && !entity.has(B)) entity.add(B);
      if (typeStep === 'removeB' && entity.has(B)) entity.remove(B);
    }
  }
}

class WatchTypes extends System {
  sked = this.schedule(s => s.after(StepTypes));
  entities = this.query(q => q.changed.withAny(A, B).read.trackWrites.trackTypes);
  execute() {
    typeSeen = {
      a: this.entities.hasChangedType(A), b: this.entities.hasChangedType(B),
      any: this.entities.anyTypeChanged
    };
  }
}

class WatchWithoutTypes extends System {
  entities = this.query(q => q.changed.with(A).read.trackWrites);
  execute() {
    this.entities.hasChangedType(A);
  }
}

describe('changed type tracking', () => {

  test('reports the types of entities created before the first frame, then nothing', async () => {
    const world = await createWorld(StepTypes, WatchTypes);
    typeStep = 'none';
    world.createEntity(A);
    world.createEntity(B);
    await world.execute();
    expect(typeSeen).toEqual({a: true, b: true, any: true});
    await world.execute();
    expect(typeSeen).toEqual({a: false, b: false, any: false});
  });

  test('reports a written type and only that type', async () => {
    const world = await createWorld(StepTypes, WatchTypes);
    typeStep = 'none';
    world.createEntity(A, B);
    await world.execute();
    await world.execute();
    typeStep = 'writeA';
    await world.execute();
    expect(typeSeen).toEqual({a: true, b: false, any: true});
    typeStep = 'none';
    await world.execute();
    expect(typeSeen).toEqual({a: false, b: false, any: false});
  });

  test('reports a type added to or removed from an entity that keeps matching', async () => {
    const world = await createWorld(StepTypes, WatchTypes);
    typeStep = 'none';
    world.createEntity(A);
    await world.execute();
    await world.execute();
    typeStep = 'addB';
    await world.execute();
    expect(typeSeen).toEqual({a: false, b: true, any: true});
    typeStep = 'removeB';
    await world.execute();
    expect(typeSeen).toEqual({a: false, b: true, any: true});
  });

  test('refuses to answer for a query without trackTypes', async () => {
    const world = await createWorld(WatchWithoutTypes);
    world.createEntity(A);
    await expect(world.execute()).rejects.toThrow('Query types not tracked');
  });

});
