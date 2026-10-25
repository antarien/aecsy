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


/* A lookup page covers 4096 entity ids, 16 KB: one fill-free allocation the first time a list holds
   an entity in that range. */
const LOOKUP_PAGE_SHIFT = 12;
const LOOKUP_PAGE_SIZE = 1 << LOOKUP_PAGE_SHIFT;
const LOOKUP_IN_PAGE = LOOKUP_PAGE_SIZE - 1;

/**
 * Maps entity ids to positions in a packed array. The lookup table stores `position + 1` so that
 * the "not in list" marker is 0, which is what freshly allocated memory already holds.
 *
 * A world holds one such list per `current` query, and a query sees a few entities out of
 * `maxEntities`. The table is therefore split into pages that are allocated when the first entity
 * of their id range enters the list: a list costs its page directory plus the pages it touched,
 * never an array over every entity id.
 */
export class PackedArrayEntityList implements EntityList {
  entities: Entity[] = [];
  private readonly lookupPages: (Int32Array | undefined)[];
  private maxOrderKey = -Infinity;
  private sorted = true;

  constructor(
    private readonly pool: EntityPool, private readonly orderBy: OrderTransform | undefined,
    maxEntities: number
  ) {
    this.lookupPages = new Array(Math.ceil(maxEntities / LOOKUP_PAGE_SIZE));
  }

  private lookup(id: EntityId): number {
    const page = this.lookupPages[id >>> LOOKUP_PAGE_SHIFT];
    return page ? page[id & LOOKUP_IN_PAGE] : 0;
  }

  private store(id: EntityId, slot: number): void {
    const pageIndex = id >>> LOOKUP_PAGE_SHIFT;
    let page = this.lookupPages[pageIndex];
    if (!page) {
      if (slot === 0) return;
      page = this.lookupPages[pageIndex] = new Int32Array(LOOKUP_PAGE_SIZE);
    }
    page[id & LOOKUP_IN_PAGE] = slot;
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
    this.store(id, index + 1);
  }

  remove(id: EntityId): void {
    const index = this.lookup(id) - 1;
    DEBUG: if (index < 0) throw new InternalError('Entity not in list');
    this.pool.return(id);
    this.store(id, 0);
    const entity = this.entities.pop()!;
    if (index < this.entities.length) {
      this.entities[index] = entity;
      this.store(entity.__id, index + 1);
      if (this.orderBy) this.sorted = false;
    }
  }

  has(id: EntityId): boolean {
    return this.lookup(id) !== 0;
  }

  clear(): void {
    // Only the ids held in `entities` have a non-zero slot, so clearing costs the list's length
    // rather than a pass over maxEntities.
    for (const entity of this.entities) {
      this.store(entity.__id, 0);
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
    for (let i = 0; i < this.entities.length; i++) this.store(this.entities[i].__id, i + 1);
    this.sorted = true;
  }
}
