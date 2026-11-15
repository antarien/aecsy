// We'll get either the dev or perf variant of becsy injected, but just take types from one since
// they're exactly the same anyway.
//
// Copyright (c) Jan Ohlmann. All rights reserved.
// Licensed to ANTARES SIMULACAO LTDA. Use is governed by LICENSE.md and PJV.md in this repository.
// SPDX-License-Identifier: LicenseRef-ASE-LIC
import type * as becsyDev from '../src/index';
type Becsy = {
  field: typeof becsyDev.field,
  Type: typeof becsyDev.Type,
  System: typeof becsyDev.System,
  World: typeof becsyDev.World
}

// The price of systems whose change query sees nothing, against the same world without them. Each
// case writes the same seven components per frame; the watchers look at types nobody writes.

const TYPE_COUNT = 500;
const WRITTEN_PER_FRAME = 7;

export default (becsy: Becsy): {[key: string]: () => Promise<any>} => {
  function makeTypes() {
    return Array.from({length: TYPE_COUNT}, () => class {
      static schema: any = {value: becsy.Type.int32};
    });
  }

  function makeWriter(types: any[]) {
    const written = types.slice(0, WRITTEN_PER_FRAME);
    return class extends becsy.System {
      entities = this.query(q => q.current.with(written[0]).write.using(...written).write);
      execute() {
        for (const entity of this.entities.current) {
          for (const type of written) (entity.write(type) as {value: number}).value += 1;
        }
      }
    };
  }

  function makeWatchers(types: any[], onlyOnChanges: boolean) {
    return types.slice(WRITTEN_PER_FRAME).map(type => class extends becsy.System {
      sked = onlyOnChanges ? this.schedule(s => s.onlyOnChanges) : undefined;
      entities = this.query(q => q.changed.with(type).read.trackWrites);
      execute() {
        for (const entity of this.entities.changed) entity.read(type);
      }
    });
  }

  async function makeWorld(withWatchers: boolean, onlyOnChanges = false) {
    const types = makeTypes();
    const defs: any[] = [...types, makeWriter(types)];
    if (withWatchers) defs.push(...makeWatchers(types, onlyOnChanges));
    const world = await becsy.World.create({defs, maxEntities: 100});
    world.build(sys => {
      sys.createEntity(...types.slice(0, WRITTEN_PER_FRAME).flatMap(type => [type, {value: 0}]));
    });
    return world;
  }

  return {
    async noWatchers() {
      return makeWorld(false);
    },

    async idleWatchers() {
      return makeWorld(true);
    },

    async idleWatchersOnlyOnChanges() {
      return makeWorld(true, true);
    },
  };
};
