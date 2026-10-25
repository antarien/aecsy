/** A binary min-heap of small non-negative integers, such as vertex ids or plan positions. */
export class MinHeap {
  private readonly items: number[] = [];

  get size(): number {
    return this.items.length;
  }

  /** The smallest value; only valid while the heap is not empty. */
  peek(): number {
    return this.items[0];
  }

  push(value: number): void {
    const items = this.items;
    let index = items.length;
    items.push(value);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (items[parent] <= value) break;
      items[index] = items[parent];
      index = parent;
    }
    items[index] = value;
  }

  pop(): number {
    const items = this.items;
    const top = items[0];
    const last = items.pop()!;
    if (items.length) {
      let index = 0;
      const length = items.length;
      while (true) {
        const left = 2 * index + 1;
        if (left >= length) break;
        const right = left + 1;
        const child = right < length && items[right] < items[left] ? right : left;
        if (items[child] >= last) break;
        items[index] = items[child];
        index = child;
      }
      items[index] = last;
    }
    return top;
  }
}
