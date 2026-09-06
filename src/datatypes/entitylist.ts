import {InternalError} from '../errors';
import type {Entity, EntityId} from '../entity';
import type {EntityPool} from '../registry';

export type OrderTransform = (entity: Entity) => number;

export interface EntityList {
  entities: Entity[];
  add(id: EntityId): void;
  clear(): void;
  sort(): void;
}


export class ArrayEntityList implements EntityList {
  readonly entities: Entity[] = [];
  private maxOrderKey = -Infinity;
  private sorted = true;

  constructor(
    private readonly pool: EntityPool, private readonly orderBy: OrderTransform | undefined
  ) {}

  add(id: EntityId): void {
    const entity = this.pool.borrowTemporarily(id);
    if (this.orderBy) {
      const orderKey = this.orderBy(entity);
      if (orderKey >= this.maxOrderKey) {
        this.maxOrderKey = orderKey;
      } else {
        this.sorted = false;
      }
    }
    this.entities.push(entity);
  }

  clear(): void {
    if (this.entities.length) this.entities.length = 0;
    this.maxOrderKey = -Infinity;
    this.sorted = true;
  }

  sort(): void {
    if (this.sorted) return;
    const orderBy = this.orderBy!;
    for (const entity of this.entities) entity.__sortKey = orderBy(entity);
    this.entities.sort((a, b) => {
      return a.__sortKey < b.__sortKey ? -1 : a.__sortKey > b.__sortKey ? +1 : 0;
    });
    this.sorted = true;
  }
}


/**
 * Maps entity ids to positions in a packed array. The lookup table stores `position + 1` so that
 * the "not in list" marker is 0, which is what freshly allocated memory already holds: the table
 * costs only address space until an entity actually lands in it. Encoding the marker as -1 would
 * force a full pass over maxEntities entries per list before the world holds a single entity.
 */
export class PackedArrayEntityList implements EntityList {
  entities: Entity[] = [];
  private readonly lookupTable: Int32Array;
  private maxOrderKey = -Infinity;
  private sorted = true;

  constructor(
    private readonly pool: EntityPool, private readonly orderBy: OrderTransform | undefined,
    maxEntities: number
  ) {
    this.lookupTable = new Int32Array(maxEntities);
  }

  add(id: EntityId): void {
    const entity = this.pool.borrow(id);
    if (this.orderBy) {
      const orderKey = this.orderBy(entity);
      if (orderKey >= this.maxOrderKey) {
        this.maxOrderKey = orderKey;
      } else {
        this.sorted = false;
      }
    }
    const index = this.entities.push(entity) - 1;
    this.lookupTable[id] = index + 1;
  }

  remove(id: EntityId): void {
    const index = this.lookupTable[id] - 1;
    DEBUG: if (index < 0) throw new InternalError('Entity not in list');
    this.pool.return(id);
    this.lookupTable[id] = 0;
    const entity = this.entities.pop()!;
    if (index < this.entities.length) {
      this.entities[index] = entity;
      this.lookupTable[entity.__id] = index + 1;
      if (this.orderBy) this.sorted = false;
    }
  }

  has(id: EntityId): boolean {
    return this.lookupTable[id] !== 0;
  }

  clear(): void {
    // Only the ids held in `entities` have a non-zero slot, so clearing costs the list's length
    // rather than a pass over maxEntities.
    for (const entity of this.entities) {
      this.lookupTable[entity.__id] = 0;
      this.pool.return(entity.__id);
    }
    this.entities = [];
    this.maxOrderKey = -Infinity;
    this.sorted = true;
  }

  sort(): void {
    if (this.sorted) return;
    const orderBy = this.orderBy!;
    for (const entity of this.entities) entity.__sortKey = orderBy(entity);
    this.entities.sort((a, b) => {
      return a.__sortKey < b.__sortKey ? -1 : a.__sortKey > b.__sortKey ? +1 : 0;
    });
    for (let i = 0; i < this.entities.length; i++) {
      this.lookupTable[this.entities[i].__id] = i + 1;
    }
    this.sorted = true;
  }
}
