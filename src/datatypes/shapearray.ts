import type {EntityId} from '../entity';
import type {Buffers} from '../buffers';
import type {ComponentType} from '../component';
import type {ComponentEnum} from '../enums';
import type {CompactMask, TrackingMask} from 'src/query';

/* Every match walks only the non-zero words of its mask (`CompactMask`), so its cost follows the
   number of component types a query names, never the id of the highest one. */
export interface ShapeArray {
  syncThreads(): void;
  set(entityId: EntityId, type: ComponentType<any>): void;
  unset(entityId: EntityId, type: ComponentType<any>): void;
  isSet(entityId: EntityId, type: ComponentType<any>): boolean;
  get(entityId: number, enumeration: ComponentEnum): number;
  clear(): void;
  match(entityId: EntityId, positive: CompactMask): boolean;
  matchNot(entityId: EntityId, negative: CompactMask): boolean;
  matchAny(entityId: EntityId, trackingMask: TrackingMask): boolean;
}


/**
 * A shape array cleared every cycle lists the words it wrote since the last clear, so clearing
 * zeroes those words instead of the whole array: the array spans every entity times every component
 * type, and a cycle writes the few that changed.
 */
class TouchedWords {
  private readonly indices: number[] = [];

  add(index: number): void {
    this.indices.push(index);
  }

  clear(array: Uint32Array): void {
    const indices = this.indices;
    // Past an eighth of the array one contiguous fill is cheaper than the scattered writes.
    if (indices.length > (array.length >>> 3)) {
      array.fill(0);
    } else {
      for (let i = 0; i < indices.length; i++) array[indices[i]] = 0;
    }
    indices.length = 0;
  }
}


export class UnsharedShapeArray implements ShapeArray {
  private readonly stride: number;
  private array: Uint32Array;
  private readonly touched: TouchedWords | undefined;

  constructor(
    bufferKey: string, numBits: number, maxEntities: number, buffers: Buffers, clearable = false
  ) {
    this.stride = Math.ceil(numBits / 32);
    buffers.register(
      bufferKey, maxEntities * this.stride, Uint32Array, shapes => {this.array = shapes;});
    if (clearable) this.touched = new TouchedWords();
  }

  syncThreads(): void {
    // no-op
  }

  set(entityId: number, type: ComponentType<any>): void {
    const binding = type.__binding!;
    const index = entityId * this.stride + binding.shapeOffset;
    const mask = binding.shapeMask;
    const value = binding.shapeValue;
    this.array[index] &= ~mask;
    this.array[index] |= value;
    this.touched?.add(index);
  }

  unset(entityId: number, type: ComponentType<any>): void {
    const binding = type.__binding!;
    const index = entityId * this.stride + binding.shapeOffset;
    const mask = binding.shapeMask;
    this.array[index] &= ~mask;
  }

  isSet(entityId: number, type: ComponentType<any>): boolean {
    const binding = type.__binding!;
    const index = entityId * this.stride + binding.shapeOffset;
    const mask = binding.shapeMask;
    const value = binding.shapeValue;
    return (this.array[index] & mask) === value;
  }

  get(entityId: number, enumeration: ComponentEnum): number {
    const binding = enumeration.__binding!;
    const index = entityId * this.stride + binding.shapeOffset;
    const mask = binding.shapeMask;
    return (this.array[index] & mask) >>> binding.shapeShift;
  }

  clear(): void {
    if (this.touched) {
      this.touched.clear(this.array);
    } else {
      this.array.fill(0);
    }
  }

  match(entityId: EntityId, positive: CompactMask): boolean {
    const array = this.array;
    const index = entityId * this.stride;
    const {offsets, masks, values} = positive;
    for (let i = 0; i < offsets.length; i++) {
      if ((array[index + offsets[i]] & masks[i]) !== values[i]) return false;
    }
    return true;
  }

  matchNot(entityId: EntityId, negative: CompactMask): boolean {
    const array = this.array;
    const index = entityId * this.stride;
    const {offsets, masks} = negative;
    for (let i = 0; i < offsets.length; i++) {
      if ((array[index + offsets[i]] & masks[i]) !== 0) return false;
    }
    return true;
  }

  matchAny(entityId: EntityId, trackingMask: TrackingMask): boolean {
    trackingMask.changed = false;
    const {offsets, masks} = trackingMask.match!;
    const lastMatch =
      trackingMask.lastMatches![entityId] = trackingMask.lastMatches![entityId] || [];
    const array = this.array;
    const index = entityId * this.stride;
    let ok = false;
    for (let i = 0; i < offsets.length; i++) {
      const masked = array[index + offsets[i]] & masks[i];
      if (masked !== 0) ok = true;
      if (masked !== lastMatch[i]) trackingMask.changed = true;
      lastMatch[i] = masked;
    }
    if (!ok) delete trackingMask.lastMatches![entityId];
    return ok;
  }
}


export class AtomicSharedShapeArray implements ShapeArray {
  private readonly stride: number;
  private array: Uint32Array;
  private readonly touched: TouchedWords | undefined;

  constructor(
    bufferKey: string, numBits: number, maxEntities: number, buffers: Buffers, clearable = false
  ) {
    this.stride = Math.ceil(numBits / 32);
    buffers.register(
      bufferKey, maxEntities * this.stride, Uint32Array, shapes => {this.array = shapes;});
    if (clearable) this.touched = new TouchedWords();
  }

  syncThreads(): void {
    // We assume that any atomic operation will force a write barrier on the whole array.
    Atomics.load(this.array, 0);
  }

  set(entityId: number, type: ComponentType<any>): void {
    const binding = type.__binding!;
    const index = entityId * this.stride + binding.shapeOffset;
    const mask = binding.shapeMask;
    const value = binding.shapeValue;
    if (mask !== value) Atomics.and(this.array, index, ~mask);
    Atomics.or(this.array, index, value);
    this.touched?.add(index);
  }

  unset(entityId: number, type: ComponentType<any>): void {
    const binding = type.__binding!;
    const index = entityId * this.stride + binding.shapeOffset;
    const mask = binding.shapeMask;
    Atomics.and(this.array, index, ~mask);
  }

  isSet(entityId: number, type: ComponentType<any>): boolean {
    const binding = type.__binding!;
    const index = entityId * this.stride + binding.shapeOffset;
    const mask = binding.shapeMask;
    const value = binding.shapeValue;
    // Entity liveness flag can be written at any time from any thread, so do atomic check.
    if (type.id === 0) return (Atomics.load(this.array, index) & mask) === value;
    return (this.array[index] & mask) === value;
  }

  get(entityId: number, enumeration: ComponentEnum): number {
    const binding = enumeration.__binding!;
    const index = entityId * this.stride + binding.shapeOffset;
    const mask = binding.shapeMask;
    return (this.array[index] & mask) >>> binding.shapeShift;
  }

  clear(): void {
    if (this.touched) {
      this.touched.clear(this.array);
    } else {
      this.array.fill(0);
    }
  }

  match(entityId: EntityId, positive: CompactMask): boolean {
    const array = this.array;
    const index = entityId * this.stride;
    const {offsets, masks, values} = positive;
    for (let i = 0; i < offsets.length; i++) {
      if ((array[index + offsets[i]] & masks[i]) !== values[i]) return false;
    }
    return true;
  }

  matchNot(entityId: EntityId, negative: CompactMask): boolean {
    const array = this.array;
    const index = entityId * this.stride;
    const {offsets, masks} = negative;
    for (let i = 0; i < offsets.length; i++) {
      if ((array[index + offsets[i]] & masks[i]) !== 0) return false;
    }
    return true;
  }

  matchAny(entityId: EntityId, trackingMask: TrackingMask): boolean {
    trackingMask.changed = false;
    const {offsets, masks} = trackingMask.match!;
    const lastMatch =
      trackingMask.lastMatches![entityId] = trackingMask.lastMatches![entityId] || [];
    const array = this.array;
    const index = entityId * this.stride;
    for (let i = 0; i < offsets.length; i++) {
      const masked = array[index + offsets[i]] & masks[i];
      if (masked === 0) {
        delete trackingMask.lastMatches![entityId];
        return false;
      }
      if (masked !== lastMatch[i]) trackingMask.changed = true;
      lastMatch[i] = masked;
    }
    return true;
  }
}
