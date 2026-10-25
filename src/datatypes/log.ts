import type {ComponentType} from '../component';
import type {Buffers} from '../buffers';
import {LOG_ENTRY_WORDS, RUN_HEADER_FLAG} from '../consts';
import {CheckError, InternalError} from '../errors';


export interface LogPointer {
  index: number;
  generation: number;
  corralIndex: number;
  corralGeneration: number;
}

interface LogOptions {
  localProcessingAllowed?: boolean;
  sortedByComponentType?: boolean;
  numComponentTypes?: number;
}


const HEADER_LENGTH = 2;
const EMPTY_TUPLE: [] = [];


/**
 * A circular log of (entity, component type) pairs with smart pointers into it.  When the log
 * wraps around it increments a generation counter so you can tell if your pointer got lapped and
 * is now invalid.
 *
 * ONE ENTRY OCCUPIES TWO SLOTS, AND THAT IS THE POINT OF THIS FORK. Upstream squeezed the pair and
 * a marker bit into a single 32-bit word, which capped a world at 512 component classes and 4.19M
 * entities. Here the entity gets a full word and the type gets its own, so neither axis pays for
 * the other (see `consts.ts`).
 *
 * ALL INDICES IN THIS CLASS COUNT WORDS, NOT ENTRIES. The wrap-around arithmetic, the generation
 * counter and the block copies are therefore untouched by the change — they were always counting
 * slots. Only the places that read or write a pair step by `LOG_ENTRY_WORDS`, and `countSince`
 * divides at the end because its callers ask for entries.
 *
 * What doubles is the record of what changed in a frame, never the component data: components keep
 * their own fields and are not stored here.
 */
export class Log {
  /* layout: [index, generation, ...entries] — index counts WORDS */
  private data: Uint32Array;
  /* layout: [length, generation, ...entries] — length counts WORDS */
  private corral: Uint32Array;
  /* layout: [length, unused, ...entries] — length counts WORDS */
  private staging: Uint32Array;
  private typeCounters: Uint32Array;
  /**
   * How many entries were pushed since the log was made, and per component type the count at its
   * last push. A reader that remembers the count it saw can ask whether any of ITS types was pushed
   * since, in one look per type, instead of walking every entry of every type to find out.
   */
  private pushes = 0;
  private lastPushByType: Float64Array;
  /** Capacity in words; `maxEntries` is the capacity the caller asked for, in entries. */
  private readonly maxWords: number;

  constructor(
    private readonly maxEntries: number, private readonly configParamName: string, buffers: Buffers,
    private readonly options: LogOptions = {
      localProcessingAllowed: false, sortedByComponentType: false, numComponentTypes: 0
    }
  ) {
    this.maxWords = maxEntries * LOG_ENTRY_WORDS;
    buffers.register(
      `log.${configParamName}.buffer`, this.maxWords + HEADER_LENGTH, Uint32Array,
      (data: Uint32Array) => {this.data = data;}
    );
    buffers.register(
      `log.${configParamName}.corral`, this.maxWords + HEADER_LENGTH, Uint32Array,
      (corral: Uint32Array) => {this.corral = corral;}
    );
    if (options.sortedByComponentType) {
      DEBUG: if (options.numComponentTypes === undefined) {
        throw new InternalError(
          `numComponentTypes required when ${this.configParamName} is sortedByComponentType`);
      }
      buffers.register(
        `log.${configParamName}.staging`, this.maxWords + HEADER_LENGTH, Uint32Array,
        (staging: Uint32Array) => {this.staging = staging;}
      );
      this.typeCounters = new Uint32Array(this.options.numComponentTypes!);
      this.lastPushByType = new Float64Array(this.options.numComponentTypes!);
    }
  }

  /**
   * Append one (entity, type) pair.
   *
   * The duplicate check compares against the pair written last. Upstream compared a single word at
   * `corral[corralLength]`, which addressed a header slot rather than the last entry; with two
   * words the last pair has to be addressed explicitly anyway, so it is now the pair that is
   * compared.
   */
  push(entityId: number, typeId: number, type?: ComponentType<any>): void {
    const corralLength = this.corral[0];
    CHECK: if (corralLength + LOG_ENTRY_WORDS > this.maxWords) this.throwCapacityExceeded();
    if (corralLength &&
        this.corral[corralLength + HEADER_LENGTH - LOG_ENTRY_WORDS] === entityId &&
        this.corral[corralLength + HEADER_LENGTH - LOG_ENTRY_WORDS + 1] === typeId) return;
    this.corral[corralLength + HEADER_LENGTH] = entityId;
    this.corral[corralLength + HEADER_LENGTH + 1] = typeId;
    this.corral[0] += LOG_ENTRY_WORDS;
    DEBUG: if (!!type !== !!this.options.sortedByComponentType) {
      throw new InternalError(
        `Pushing value ${type ? 'with' : 'without'} type to log ${this.configParamName} ` +
        `${this.options.sortedByComponentType ? '' : 'not '}sorted by component type`);
    }
    this.pushes += 1;
    if (type) {
      this.typeCounters[type.id!] += 1;
      this.lastPushByType[type.id!] = this.pushes;
    }
  }

  /** The number of entries pushed since the log was made; a reader keeps it for `hasPushesOf`. */
  get pushCount(): number {
    return this.pushes;
  }

  /**
   * Whether an entry of any of the given component types was pushed after the reader saw
   * `seenCount`. Only a log sorted by component type keeps the count per type.
   */
  hasPushesOf(typeIds: readonly number[], seenCount: number): boolean {
    for (let i = 0; i < typeIds.length; i++) {
      if (this.lastPushByType[typeIds[i]] > seenCount) return true;
    }
    return false;
  }

  commit(pointer?: LogPointer): boolean {
    DEBUG: if (!pointer && this.options.localProcessingAllowed) {
      throw new InternalError(
        `Cannot use blind commit when local processing is allowed in log ${this.configParamName}`);
    }
    if (!this.corral[0]) return true;
    if (pointer && !(
      pointer.generation === this.data[1] && pointer.index === this.data[0] &&
      pointer.corralGeneration === this.corral[1] && pointer.corralIndex === this.corral[0]
    )) return false;
    this.copyToData(this.staging ? this.sortCorral() : this.corral);
    this.corral[0] = 0;
    this.corral[1] += 1;
    if (pointer) {
      pointer.index = this.data[0];
      pointer.generation = this.data[1];
    }
    return true;
  }

  /**
   * Group the corral by component type, inserting a run header before each group of more than one.
   *
   * `typeCounters` counts ENTRIES per type, but every offset it carries afterwards is a WORD
   * offset, because that is how the staging buffer is indexed. A run header occupies a full entry
   * slot like any other: its first word holds the run length, its second the type id with the
   * marker bit — the marker sits in the type word because the entity word has no spare bit left.
   */
  private sortCorral(): Uint32Array {
    let offset = HEADER_LENGTH, soleTypeId = -1, soleTypeCount = 0, numNonZeroTypes = 0;
    for (let typeId = 0; typeId < this.typeCounters.length; typeId++) {
      const count = this.typeCounters[typeId];
      if (!count) continue;
      CHECK: numNonZeroTypes += 1;
      if (soleTypeId === -1) {
        soleTypeId = typeId;
        soleTypeCount = count;
      } else if (soleTypeId >= 0) {
        soleTypeId = -2;
      }
      if (count === 1) {
        this.typeCounters[typeId] = offset;
        offset += LOG_ENTRY_WORDS;
      } else {
        this.typeCounters[typeId] = offset + LOG_ENTRY_WORDS;
        this.staging[offset] = count;
        this.staging[offset + 1] = typeId | RUN_HEADER_FLAG;
        offset += (count + 1) * LOG_ENTRY_WORDS;
      }
    }
    if (soleTypeId >= 0) {
      if (soleTypeCount > 1) {
        CHECK: {
          if (this.corral[0] + LOG_ENTRY_WORDS > this.maxWords) this.throwCapacityExceeded();
        }
        this.corral[this.corral[0] + HEADER_LENGTH] = this.corral[HEADER_LENGTH];
        this.corral[this.corral[0] + HEADER_LENGTH + 1] = this.corral[HEADER_LENGTH + 1];
        this.corral[HEADER_LENGTH] = this.corral[0] / LOG_ENTRY_WORDS;
        this.corral[HEADER_LENGTH + 1] = soleTypeId | RUN_HEADER_FLAG;
        this.corral[0] += LOG_ENTRY_WORDS;
      }
      this.typeCounters.fill(0);
      return this.corral;
    }
    CHECK: {
      if (this.corral[0] + numNonZeroTypes * LOG_ENTRY_WORDS > this.maxWords) {
        this.throwCapacityExceeded();
      }
    }
    const corralAndHeaderLength = this.corral[0] + HEADER_LENGTH;
    for (let i = HEADER_LENGTH; i < corralAndHeaderLength; i += LOG_ENTRY_WORDS) {
      const entityId = this.corral[i];
      const typeId = this.corral[i + 1];
      const target = this.typeCounters[typeId];
      this.staging[target] = entityId;
      this.staging[target + 1] = typeId;
      this.typeCounters[typeId] = target + LOG_ENTRY_WORDS;
    }
    this.staging[0] = offset - HEADER_LENGTH;
    this.typeCounters.fill(0);
    return this.staging;
  }

  private copyToData(source: Uint32Array): void {
    let index = this.data[0];
    const length = source[0];
    const firstSegmentLength = Math.min(length, this.maxWords - index);
    this.data.set(
      source.subarray(HEADER_LENGTH, firstSegmentLength + HEADER_LENGTH),
      index + HEADER_LENGTH
    );
    if (firstSegmentLength < length) {
      this.data.set(
        source.subarray(firstSegmentLength + HEADER_LENGTH, length + HEADER_LENGTH),
        HEADER_LENGTH
      );
    }
    index += length;
    while (index >= this.maxWords) {
      index -= this.maxWords;
      this.data[1] += 1;
    }
    this.data[0] = index;
  }

  createPointer(pointer?: LogPointer): LogPointer {
    if (!pointer) {
      return {
        index: this.data[0], generation: this.data[1],
        corralIndex: this.corral[0], corralGeneration: this.corral[1]
      };
    }
    pointer.index = this.data[0];
    pointer.generation = this.data[1];
    pointer.corralIndex = this.corral[0];
    pointer.corralGeneration = this.corral[1];
    return pointer;
  }

  copyPointer(pointer: LogPointer): LogPointer {
    return {
      index: pointer.index, generation: pointer.generation,
      corralIndex: pointer.corralIndex, corralGeneration: pointer.corralGeneration
    };
  }

  hasUpdatesSince(pointer: LogPointer): boolean {
    CHECK: this.checkPointer(pointer);
    return !(
      pointer.index === this.data[0] && pointer.generation === this.data[1] &&
      (pointer.corralGeneration === this.corral[1] ?
        pointer.corralIndex === this.corral[0] : this.corral[0] === 0)
    );
  }

  processSince(
    startPointer: LogPointer, endPointer?: LogPointer
  ): [Uint32Array, number, number, boolean] | [] {
    CHECK: this.checkPointers(startPointer, endPointer);
    let result: [Uint32Array, number, number, boolean] | [] = EMPTY_TUPLE;
    const endIndex = endPointer?.index ?? this.data[0];
    const endGeneration = endPointer?.generation ?? this.data[1];
    if (startPointer.generation === endGeneration) {
      if (startPointer.index < endIndex) {
        result = [
          this.data, startPointer.index + HEADER_LENGTH, endIndex + HEADER_LENGTH, false
        ];
        startPointer.index = endIndex;
      } else {
        const corralLength = this.corral[0];
        const corralGeneration = this.corral[1];
        const corralHasNewEntries = startPointer.corralGeneration === corralGeneration ?
          startPointer.corralIndex < corralLength : corralLength;
        if (corralHasNewEntries) {
          result = [
            this.corral, startPointer.corralIndex + HEADER_LENGTH,
            corralLength + HEADER_LENGTH, true
          ];
          startPointer.corralIndex = corralLength;
          startPointer.corralGeneration = corralGeneration;
        }
      }
    } else {
      result = [this.data, startPointer.index + HEADER_LENGTH, this.data.length, false];
      startPointer.index = 0;
      startPointer.generation = endGeneration;
    }
    return result;
  }

  processAndCommitSince(startPointer: LogPointer): [Uint32Array, number, number, boolean] | [] {
    const result = this.processSince(startPointer);
    if (result[0]) return result;
    if (this.commit(startPointer)) return EMPTY_TUPLE;
    return this.processSince(startPointer);
  }

  countSince(startPointer: LogPointer, endPointer?: LogPointer): number {
    CHECK: this.checkPointers(startPointer, endPointer);
    DEBUG: if (this.corral[0]) {
      throw new InternalError(`Should commit log ${this.configParamName} before counting`);
    }
    const startIndex = startPointer.index;
    const startGeneration = startPointer.generation;
    const endIndex = endPointer?.index ?? this.data[0];
    const endGeneration = endPointer?.generation ?? this.data[1];
    startPointer.index = endIndex;
    startPointer.generation = endGeneration;
    if (startIndex === endIndex && startGeneration === endGeneration) return 0;
    /* The pointers walk WORDS; callers count ENTRIES, so the span is divided at the end. */
    if (startIndex < endIndex) return (endIndex - startIndex) / LOG_ENTRY_WORDS;
    return (this.maxWords - (startIndex - endIndex)) / LOG_ENTRY_WORDS;
  }

  private checkPointers(startPointer: LogPointer, endPointer?: LogPointer): void {
    this.checkPointer(startPointer);
    if (endPointer) {
      this.checkPointer(endPointer);
      DEBUG: {
        if (startPointer.index > endPointer.index &&
            startPointer.generation >= endPointer.generation) {
          throw new InternalError(
            `Start pointer exceeds end pointer in log ${this.configParamName}`);
        }
      }
    }
  }

  private checkPointer(pointer: LogPointer): void {
    const index = this.data[0];
    let generation = pointer.generation;
    if (pointer.index === index) {
      if (generation + 1 < this.data[1]) this.throwCapacityExceeded();
    } else {
      if (pointer.index > index) generation += 1;
      if (generation !== this.data[1]) this.throwCapacityExceeded();
    }
    DEBUG: {
      if (pointer.corralGeneration > this.corral[1]) {
        throw new InternalError(
          `Pointer corral generation older than corral in log ${this.configParamName}`);
      }
      if (pointer.corralGeneration === this.corral[1] && pointer.corralIndex > this.corral[0]) {
        throw new InternalError(`Pointer past end of corral area in log ${this.configParamName}`);
      }
    }
  }

  private throwCapacityExceeded(): void {
    throw new CheckError(
      `Log capacity exceeded, please raise ${this.configParamName} above ${this.maxEntries}`);
  }
}
