import {World, component, field, System} from '../src';

/**
 * THE CEILING THIS FORK EXISTS TO REMOVE.
 *
 * Upstream packed (entity, component type) into a single 32-bit word, leaving 9 bits for the type:
 * a world could hold 512 component classes and no more. This test builds a world with well over
 * that and asserts it runs — it fails against upstream with "Too many component types" and is the
 * regression guard for anyone tempted to pack the pair back into one word.
 */

const NUM_TYPES = 1200;

function makeTypes(count: number): any[] {
  const types: any[] = [];
  for (let i = 0; i < count; i++) {
    class Generated {
      declare value: number;
    }
    Object.defineProperty(Generated, 'name', {value: `Generated${i}`});
    field.int32(Generated.prototype, 'value');
    component(Generated);
    types.push(Generated);
  }
  return types;
}

describe('wide component ids', () => {
  test(`a world holds ${NUM_TYPES} component types`, async () => {
    const types = makeTypes(NUM_TYPES);
    const first = types[0], last = types[NUM_TYPES - 1];
    let seenFirst = -1, seenLast = -1;

    class Reader extends System {
      private readonly firstQuery = this.query(q => q.current.with(first).read);
      private readonly lastQuery = this.query(q => q.current.with(last).read);
      execute(): void {
        /* The types are generated at runtime, so their shape is not statically known here. */
        for (const e of this.firstQuery.current) seenFirst = (e.read(first) as any).value;
        for (const e of this.lastQuery.current) seenLast = (e.read(last) as any).value;
      }
    }

    const world = await World.create({
      maxEntities: 100, defs: [types, Reader]
    });
    world.build(sys => {
      sys.createEntity(first, {value: 11});
      sys.createEntity(last, {value: 22});
    });
    await world.execute();

    /* The last type carries an id above the old 9-bit ceiling; reading it back proves the pair
       survived the log round trip rather than being masked into a different type. */
    expect(seenFirst).toBe(11);
    expect(seenLast).toBe(22);
    await world.terminate();
  });
});
