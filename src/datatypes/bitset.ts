import {InternalError} from '../errors';

/* A page holds 1024 words, 32768 bits: an entity range that a query touching it at all will likely
   touch again, and a size one fill zeroes in a few hundred nanoseconds. */
const PAGE_SHIFT = 15;
const PAGE_WORDS = 1024;
const WORD_IN_PAGE = PAGE_WORDS - 1;

/**
 * A fixed but arbitrary size bitset that allocates its storage page by page.
 *
 * Queries hold bitsets over `maxEntities`, and a world can hold thousands of queries that each see
 * a handful of entities. A page is allocated when its first bit is set, so a bitset costs its page
 * directory plus the pages it touched, never the whole field. Clearing zeroes only the pages
 * touched since the last clear.
 */
export class Bitset {
  private readonly pages: (Uint32Array | undefined)[];
  /* The indices of the pages written since the last clear, each listed once. */
  private readonly touchedPages: number[] = [];
  private readonly pageTouched: Uint8Array;

  constructor(private readonly size: number) {
    const pageCount = Math.ceil(size / (PAGE_WORDS * 32));
    this.pages = new Array(pageCount);
    this.pageTouched = new Uint8Array(pageCount);
  }

  get(index: number): boolean {
    DEBUG: {
      if (index < 0 || index >= this.size) {
        throw new InternalError(`Bit index out of bounds: ${index}`);
      }
    }
    const page = this.pages[index >>> PAGE_SHIFT];
    if (!page) return false;
    return (page[(index >>> 5) & WORD_IN_PAGE] & (1 << (index & 31))) !== 0;
  }

  set(index: number): void {
    DEBUG: {
      if (index < 0 || index >= this.size) {
        throw new InternalError(`Bit index out of bounds: ${index}`);
      }
    }
    const pageIndex = index >>> PAGE_SHIFT;
    let page = this.pages[pageIndex];
    if (!page) page = this.pages[pageIndex] = new Uint32Array(PAGE_WORDS);
    if (!this.pageTouched[pageIndex]) {
      this.pageTouched[pageIndex] = 1;
      this.touchedPages.push(pageIndex);
    }
    page[(index >>> 5) & WORD_IN_PAGE] |= (1 << (index & 31));
  }

  unset(index: number): void {
    DEBUG: {
      if (index < 0 || index >= this.size) {
        throw new InternalError(`Bit index out of bounds: ${index}`);
      }
    }
    const page = this.pages[index >>> PAGE_SHIFT];
    if (page) page[(index >>> 5) & WORD_IN_PAGE] &= ~(1 << (index & 31));
  }

  clear(): void {
    const touchedPages = this.touchedPages;
    for (let i = 0; i < touchedPages.length; i++) {
      const pageIndex = touchedPages[i];
      this.pages[pageIndex]!.fill(0);
      this.pageTouched[pageIndex] = 0;
    }
    touchedPages.length = 0;
  }
}
