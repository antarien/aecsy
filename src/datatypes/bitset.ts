import {InternalError} from '../errors';

/**
 * A fixed but arbitrary size bitset.
 *
 * Clearing costs time in proportion to the words written since the last clear, not to the size.
 * Queries hold bitsets over `maxEntities` and clear them every frame they process a shape or
 * write log; a full fill there costs the whole field per query per frame even when a handful of
 * entities changed. Every word that receives a bit is listed once, and `clear` zeroes only the
 * listed words.
 */
export class Bitset {
  private readonly bytes: Uint32Array;
  /* One bit per word of `bytes`: set while that word stands in `touchedWords`. */
  private readonly listedWords: Uint32Array;
  private touchedWords: Uint32Array;
  private touchedCount = 0;

  constructor(private readonly size: number) {
    const words = Math.ceil(size / 32);
    this.bytes = new Uint32Array(words);
    this.listedWords = new Uint32Array(Math.ceil(words / 32));
    this.touchedWords = new Uint32Array(Math.min(words, 16));
  }

  get(index: number): boolean {
    DEBUG: {
      if (index < 0 || index >= this.size) {
        throw new InternalError(`Bit index out of bounds: ${index}`);
      }
    }
    return (this.bytes[index >>> 5] & (1 << (index & 31))) !== 0;
  }

  set(index: number): void {
    DEBUG: {
      if (index < 0 || index >= this.size) {
        throw new InternalError(`Bit index out of bounds: ${index}`);
      }
    }
    const word = index >>> 5;
    const listedBit = 1 << (word & 31);
    if ((this.listedWords[word >>> 5] & listedBit) === 0) {
      this.listedWords[word >>> 5] |= listedBit;
      if (this.touchedCount === this.touchedWords.length) this.growTouchedWords();
      this.touchedWords[this.touchedCount++] = word;
    }
    this.bytes[word] |= (1 << (index & 31));
  }

  unset(index: number): void {
    DEBUG: {
      if (index < 0 || index >= this.size) {
        throw new InternalError(`Bit index out of bounds: ${index}`);
      }
    }
    this.bytes[index >>> 5] &= ~(1 << (index & 31));
  }

  clear(): void {
    /* Past an eighth of the words the scattered writes cost more than one contiguous fill. */
    if (this.touchedCount > (this.bytes.length >>> 3)) {
      this.bytes.fill(0);
      this.listedWords.fill(0);
    } else {
      for (let i = 0; i < this.touchedCount; i++) {
        const word = this.touchedWords[i];
        this.bytes[word] = 0;
        this.listedWords[word >>> 5] = 0;
      }
    }
    this.touchedCount = 0;
  }

  private growTouchedWords(): void {
    /* A word is listed at most once between clears, so the list never outgrows `bytes`. */
    const grown = new Uint32Array(Math.min(this.bytes.length, this.touchedWords.length * 2));
    grown.set(this.touchedWords);
    this.touchedWords = grown;
  }
}
